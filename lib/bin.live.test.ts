import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
// Type only, and the module's own db layer is imported inside beforeAll: the
// shared Prisma client is built the first time it is imported and reads
// DATABASE_URL as it goes.
import type { ExtendedPrismaClient } from '@/lib/db/prisma'
import {
  vpsConfigFromEnv,
  createTestRole,
  createTestDatabase,
  dropTestDatabase,
  dropTestRole,
  dropStaleTestObjects,
  type VpsConfig,
  type TestRole,
  type TestDatabase,
} from '@/lib/backup/vps-database'

// ---------------------------------------------------------------------------
// The bin, executed.
//
// `migrations/052_bin.sql` and the clauses that read it are raw SQL, and
// NOTHING else in this repository runs them: `tsc` sees a template string,
// `eslint` sees a template string, a build never executes a query, and the
// module build gate compiles rather than connects. A query Postgres will not
// parse is green everywhere until a customer opens the screen - and the clause
// here is nested three deep, which is exactly the shape that is fine in
// TypeScript and wrong in SQL.
//
// It matters more here than it does anywhere else in the module, because this
// is the one folder with a button on it that destroys what it holds. A bin
// clause that listed one conversation too many would destroy one conversation
// too many, and there is no putting that back.
//
// Seven claims, each about the DATABASE rather than about the TypeScript:
//
//   1. A DELETION IS ONE PERSON'S. Emma deleting something out of a shared
//      address takes it off Emma's lists and leaves Marcus's exactly as they
//      were. A clause that read the conversation rather than the reader would
//      quietly clear the address for everybody.
//   2. A COLLEAGUE'S OWN POST GOES IN THEIR BIN. Marcus, covering Sam's inbox,
//      deletes something: the row is SAM's, it is in SAM's bin, and it is not
//      in Marcus's.
//   3. THE FOLDER IS NARROWER THAN THE HIDING. Sam's deletion leaves the lists
//      of everybody covering Sam, and shows in nobody's bin but Sam's.
//   4. THE BIN BEATS THE SPAM FOLDER. Something marked as junk and then deleted
//      is out of the Spam folder and in the Bin - one place, explicable, and
//      not "in two folders and showing in neither".
//   5. THE COUNTS AGREE WITH THE LISTS. openCounts drops what a bin holds, or
//      the rail says four with three things behind it.
//   6. EMPTYING TAKES EXACTLY WHAT THE FOLDER SHOWS. binThreadIds returns the
//      folder's own contents and nothing from an address the reader may not
//      open (E17).
//   7. AND THE DELETE ACTUALLY CASCADES. deleteThreads removes the
//      conversations and the bin rows pointing at them, so an emptied bin is
//      empty rather than full of rows pointing at nothing.
//
// A real throwaway database on the Postgres VPS, built from the core schema and
// this module's own migrations. Named `cactus_rt_*` and dropped afterwards; the
// live site's database sits on the same server and is never named, opened or
// altered.
//
// Skipped unless opted into, so a plain `npm test` never touches the network:
//
//   RUN_INBOX_BIN_GUARDS=1 npx vitest run \
//     modules/unified-inbox/lib/bin.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_BIN_GUARDS === '1'
if (shouldRun) {
  try {
    ;(process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile('.env')
  } catch {
    // No .env - the guard below fails the suite loudly rather than skipping.
  }
}

const CORE_SCHEMA = path.join(process.cwd(), 'prisma/migrations/20260626000000_init/migration.sql')
const MODULE_MIGRATIONS = path.join(process.cwd(), 'modules/unified-inbox/migrations')

const KEY = 'a'.repeat(64)

type Extension = (typeof import('@/lib/db/prisma'))['stalePlanRetryExtension']

async function connect(uri: string, extension: Extension): Promise<ExtendedPrismaClient> {
  const db = new PrismaClient({ datasourceUrl: uri }).$extends(extension)
  for (let attempt = 0; ; attempt++) {
    try {
      await db.$queryRawUnsafe('SELECT 1')
      return db
    } catch (err) {
      if (attempt >= 15) throw err
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}

type Db = typeof import('./db')
type Bin = typeof import('./bin')
type Spam = typeof import('./spam')

describe.runIf(shouldRun)('the bin, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: Db
  let bin: Bin
  let spam: Spam
  let applyFile: (file: string) => Promise<void>

  let team = ''
  let samBox = ''
  let secret = ''

  const sam = 'user-sam'
  const marcus = 'user-marcus'
  const emma = 'user-emma'

  /** Everything a named reader can see across the two addresses they may open,
   *  as the screen asks it: their own lists, with the bin hidden the way the
   *  hub hides it. */
  const listFor = async (reader: string): Promise<string[]> => (
    await lib.listThreads({
      viewerUserId: reader,
      inboxIds: [team, samBox],
      includeUnrouted: false,
      status: 'all',
      page: 1,
      perPage: 50,
    })
  ).map((row) => row.id)

  /** One named person's bin. `owner` is whose - undefined would mean "the
   *  reader's own", and the difference between the two is claim 3. */
  const binOf = async (reader: string, owner: string | null): Promise<string[]> => (
    await lib.listThreads({
      viewerUserId: reader,
      binOnly: true,
      binOwnerUserId: owner,
      inboxIds: [team, samBox],
      includeUnrouted: false,
      status: 'all',
      page: 1,
      perPage: 50,
    })
  ).map((row) => row.id)

  /** And the junk folder, so claim 4 can be asked of both at once. */
  const spamOf = async (reader: string, owner: string | null): Promise<string[]> => (
    await lib.listThreads({
      viewerUserId: reader,
      spamOnly: true,
      spamOwnerUserId: owner,
      inboxIds: [team, samBox],
      includeUnrouted: false,
      status: 'all',
      page: 1,
      perPage: 50,
    })
  ).map((row) => row.id)

  /** What the "Empty bin" route would take, asked the way the route asks it. */
  const binIds = async (owner: string, inboxIds: string[]): Promise<string[]> =>
    lib.binThreadIds({ ownerUserId: owner, inboxIds, includeUnrouted: false })

  const threadIn = async (inboxId: string, subject: string): Promise<string> =>
    await lib.createThread({
      inboxId,
      subject,
      subjectNormalised: subject.toLowerCase(),
      preview: 'A quote for eight desks',
      lastMessageAt: new Date('2026-09-01T09:00:00Z'),
      lastDirection: 'in',
      unread: true,
    })

  beforeAll(async () => {
    if (!process.env.OVH_SERVER || !process.env.OVH_USER || !process.env.OVH_PASSWORD) {
      throw new Error(
        'OVH_SERVER, OVH_USER and OVH_PASSWORD are needed for this suite. Export them from the Deskwell workspace .env - a skip here is a fail.',
      )
    }
    vps = vpsConfigFromEnv()
    await dropStaleTestObjects(vps)

    const stamp = Date.now()
    role = await createTestRole(vps, `cactus_rt_role_${stamp}`)
    database = await createTestDatabase(vps, `cactus_rt_uinbin_${stamp}`, role)
    process.env.DATABASE_URL = database.connectionUri
    process.env.ENCRYPTION_KEY = KEY

    const { stalePlanRetryExtension } = await import('@/lib/db/prisma')
    const { splitSqlStatements } = await import('@/lib/backup/restore')
    db = await connect(database.connectionUri, stalePlanRetryExtension)

    applyFile = async (file: string) => {
      for (const statement of splitSqlStatements(readFileSync(file, 'utf8'))) {
        await db.$executeRawUnsafe(statement)
      }
    }
    await applyFile(CORE_SCHEMA)
    for (const file of readdirSync(MODULE_MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      await applyFile(path.join(MODULE_MIGRATIONS, file))
    }

    lib = await import('./db')
    bin = await import('./bin')
    spam = await import('./spam')

    // Real people: uin_thread_bin carries a foreign key to "User" on both
    // sides, and the CASCADE on it is part of what makes a deletion a person's
    // rather than a fact about the mail.
    await db.$executeRawUnsafe(`INSERT INTO "Role" ("id", "name") VALUES ('role-staff', 'Staff')`)
    for (const [id, email, username] of [
      [sam, 'sam@deskwell.co.uk', 'sam'],
      [marcus, 'marcus@deskwell.co.uk', 'marcus'],
      [emma, 'emma@deskwell.co.uk', 'emma'],
    ]) {
      await db.$executeRawUnsafe(
        `INSERT INTO "User" ("id", "email", "username", "roleId", "updatedAt")
         VALUES ($1, $2, $3, 'role-staff', now())`,
        id, email, username,
      )
    }

    team = (await lib.createInbox({ name: 'Sales', address: 'sales@deskwell.co.uk' })).id
    samBox = (await lib.createInbox({
      name: 'Sam', address: 'sam@deskwell.co.uk', kind: 'individual', ownerUserId: sam,
    })).id
    // An address nobody in this test may open, for claim 6: emptying a bin must
    // never reach past what the reader can see, however full the bin is.
    secret = (await lib.createInbox({ name: 'Board', address: 'board@deskwell.co.uk' })).id
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('takes a deletion off the list of the person who made it, and nobody else’s', async () => {
    const id = await threadIn(team, 'Eight desks 1')

    // The shared address belongs to the team, so the decision is the presser's.
    expect(bin.binOwnerFor({
      pressedByUserId: emma,
      inbox: { kind: 'shared', ownerUserId: null },
    })).toBe(emma)

    await bin.markThreadBinned(id, emma)

    expect(await listFor(emma)).not.toContain(id)
    expect(await listFor(marcus)).toContain(id)
    expect(await binOf(emma, emma)).toContain(id)
    expect(await binOf(marcus, marcus)).not.toContain(id)

    // And back out again with the same press, which is the whole difference
    // between a bin and the button that empties one.
    await bin.unmarkThreadBinned(id, emma)
    expect(await listFor(emma)).toContain(id)
    expect(await binOf(emma, emma)).not.toContain(id)
  })

  it('puts a colleague’s own post in THEIR bin, and hides it from everybody covering them', async () => {
    const id = await threadIn(samBox, 'Eight desks 2')

    expect(bin.binOwnerFor({
      pressedByUserId: marcus,
      inbox: { kind: 'individual', ownerUserId: sam },
    })).toBe(sam)

    // Marcus presses it; Sam's bin is where it lands.
    await bin.markThreadBinned(id, sam)

    // Claim 2: the row is Sam's.
    const rows = await db.$queryRawUnsafe<{ user_id: string }[]>(
      `SELECT "user_id" FROM "uin_thread_bin" WHERE "thread_id" = $1`, id,
    )
    expect(rows.map((r) => r.user_id)).toEqual([sam])

    // Claim 3: it is out of the lists of BOTH of them - covering somebody and
    // reading over their shoulder are the same job, so a coverer must not go on
    // working post the owner has thrown away.
    expect(await listFor(sam)).not.toContain(id)
    expect(await listFor(marcus)).not.toContain(id)

    // ...and it is in exactly one bin, which is Sam's.
    expect(await binOf(sam, sam)).toContain(id)
    expect(await binOf(marcus, sam)).toContain(id)
    expect(await binOf(marcus, marcus)).not.toContain(id)
  })

  it('takes something out of the Spam folder once it has been deleted', async () => {
    const id = await threadIn(team, 'Eight desks 3')
    await spam.markThreadSpam(id, emma)
    expect(await spamOf(emma, emma)).toContain(id)

    await bin.markThreadBinned(id, emma)

    // Claim 4: one folder, and it is the bin. A conversation showing in both
    // would be one somebody could delete out of the junk folder and then find
    // still sitting in it; a conversation showing in neither would be one
    // nobody could reach at all.
    expect(await spamOf(emma, emma)).not.toContain(id)
    expect(await binOf(emma, emma)).toContain(id)
    expect(await listFor(emma)).not.toContain(id)
  })

  it('drops what a bin holds out of the numbers on the rail', async () => {
    const id = await threadIn(team, 'Eight desks 4')
    const before = (await lib.openCounts(emma, [team, samBox], false))[team] ?? 0
    await bin.markThreadBinned(id, emma)
    const after = (await lib.openCounts(emma, [team, samBox], false))[team] ?? 0
    // Claim 5. A count drawn from a different WHERE than its list is a rail
    // saying four over a folder holding three.
    expect(after).toBe(before - 1)
  })

  it('offers up exactly the folder’s own contents to be emptied, and nothing behind it', async () => {
    // A conversation in an address these readers cannot open, deleted into the
    // same person's bin. It is in the bin as a row; it must not be offered up
    // to a reader who cannot see the address it sits in.
    const hidden = await threadIn(secret, 'Board papers')
    await bin.markThreadBinned(hidden, emma)

    const ids = await binIds(emma, [team, samBox])
    expect(ids).not.toContain(hidden)
    // And everything that IS in the folder is in the list, or the button would
    // say "empty" and leave things behind.
    const shown = await binOf(emma, emma)
    expect([...ids].sort()).toEqual([...shown].sort())

    // Claim 6, said the other way: a reader who CAN open the address gets it.
    const all = await binIds(emma, [team, samBox, secret])
    expect(all).toContain(hidden)
  })

  it('empties by destroying the conversations, and the bin rows go with them', async () => {
    const id = await threadIn(team, 'Eight desks 5')
    await bin.markThreadBinned(id, marcus)
    expect(await binOf(marcus, marcus)).toContain(id)

    const ids = await binIds(marcus, [team, samBox])
    expect(ids).toContain(id)
    expect(await lib.deleteThreads(ids)).toBeGreaterThan(0)

    // Claim 7. The conversation is gone, and so is the row that said it was in
    // a bin - an emptied bin holding rows that point at nothing would be a
    // folder that could never be emptied again.
    const left = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*)::bigint AS n FROM "uin_threads" WHERE "id" = $1`, id,
    )
    expect(Number(left[0]!.n)).toBe(0)
    const orphans = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*)::bigint AS n FROM "uin_thread_bin" WHERE "thread_id" = $1`, id,
    )
    expect(Number(orphans[0]!.n)).toBe(0)
    expect(await binOf(marcus, marcus)).not.toContain(id)
  })

})
