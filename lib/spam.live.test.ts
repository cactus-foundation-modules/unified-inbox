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
// Junk, executed.
//
// `migrations/041_spam.sql` and the clauses that read it are raw SQL, and
// NOTHING else in this repository runs them: `tsc` sees a template string,
// `eslint` sees a template string, a build never executes a query, and the
// module build gate compiles rather than connects. A query Postgres will not
// parse is green everywhere until a customer opens the screen - and the clause
// here is nested three deep, which is exactly the shape that is fine in
// TypeScript and wrong in SQL.
//
// Six claims, each about the DATABASE rather than about the TypeScript:
//
//   1. Junk is ONE PERSON'S. Emma filing something in a shared address takes it
//      off Emma's lists and leaves Marcus's exactly as they were. This is the
//      whole model, and a clause that read the conversation rather than the
//      reader would quietly clear the address for everybody.
//   2. A COLLEAGUE'S OWN POST GOES IN THEIR BIN. Marcus, covering Sam's inbox,
//      throws something away: the row is SAM's, it is in SAM's spam folder, and
//      it is NOT in Marcus's.
//   3. And it leaves the coverer's lists too. Covering somebody means seeing
//      what they would see; a bin that emptied for one of them would have
//      Marcus working through post Sam had already dealt with.
//   4. A spam folder scoped to nobody - a shared address, or an id the reader
//      may not open - is EMPTY rather than quietly falling back to their own
//      junk under somebody else's name (E17).
//   5. The unread tallies agree with the lists. They carry their own copy of
//      the clause, and a number that disagreed with the list behind it is the
//      defect a spam folder must not have.
//   6. The block list round-trips: written normalised, read back as a set,
//      asked one at a time, and removed.
//   7. POST FROM A BLOCKED SENDER IS IN THE BIN FOR EVERYBODY. The stamp is a
//      column on the conversation rather than a row per person (migration 044),
//      so both junk clauses had to learn to read a second thing, and the one
//      that hides has to agree with the one that lists. It is out of every
//      list, in every real bin, done, unread - and pressing "Not junk" takes
//      the stamp off again, which is the only way out of the folder and
//      therefore the one that must not be broken.
//
// A real throwaway database on the Postgres VPS, built from the core schema and
// this module's own migrations. Named `cactus_rt_*` and dropped afterwards; the
// live site's database sits on the same server and is never named, opened or
// altered.
//
// Skipped unless opted into, so a plain `npm test` never touches the network:
//
//   RUN_INBOX_SPAM_GUARDS=1 npx vitest run \
//     modules/unified-inbox/lib/spam.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_SPAM_GUARDS === '1'
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
type Spam = typeof import('./spam')
type Blocked = typeof import('./blocked-senders')

describe.runIf(shouldRun)('junk and blocked senders, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: Db
  let spam: Spam
  let blocked: Blocked
  let applyFile: (file: string) => Promise<void>

  let team = ''
  let samBox = ''

  const sam = 'user-sam'
  const marcus = 'user-marcus'
  const emma = 'user-emma'

  /** Everything a named reader can see across both addresses, as the screen
   *  asks it: their own lists, with junk hidden the way the hub hides it. */
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
   *  reader's own", and the difference between the two is claim 4. */
  const binOf = async (reader: string, owner: string | null): Promise<string[]> => (
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

  const threadIn = async (inboxId: string, subject: string): Promise<string> =>
    await lib.createThread({
      inboxId,
      subject,
      subjectNormalised: subject.toLowerCase(),
      preview: 'Buy cheap desks now',
      lastMessageAt: new Date('2026-09-01T09:00:00Z'),
      lastDirection: 'in',
      unread: true,
    })

  /** Where a conversation stands and whether anybody has read it - asked of the
   *  database rather than of the code that wrote it, since "done but unread" is
   *  the whole of what the stamp is supposed to leave behind. */
  const stateOf = async (id: string): Promise<{ status: string; unread: boolean; blocked: boolean }> => {
    const rows = await db.$queryRawUnsafe<{ status: string; unread: boolean; blocked_at: Date | null }[]>(
      `SELECT "status", "unread", "blocked_at" FROM "uin_threads" WHERE "id" = $1`, id,
    )
    const row = rows[0]!
    return { status: row.status, unread: row.unread, blocked: row.blocked_at !== null }
  }

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
    database = await createTestDatabase(vps, `cactus_rt_uinspam_${stamp}`, role)
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
    spam = await import('./spam')
    blocked = await import('./blocked-senders')

    // Real people: uin_thread_spam carries a foreign key to "User" on both
    // sides, and the CASCADE on it is part of what makes a junk mark a
    // person's rather than a fact about the mail.
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
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('takes junk off the list of the person who filed it, and nobody else’s', async () => {
    const id = await threadIn(team, 'Cheap desks 1')

    // The shared address belongs to the team, so the opinion is the presser's.
    expect(spam.spamOwnerFor({
      pressedByUserId: emma,
      inbox: { kind: 'shared', ownerUserId: null },
    })).toBe(emma)

    await spam.markThreadSpam(id, emma)

    expect(await listFor(emma)).not.toContain(id)
    // Marcus reads the same address and has no opinion about it.
    expect(await listFor(marcus)).toContain(id)
    expect(await binOf(emma, emma)).toContain(id)
    expect(await binOf(marcus, marcus)).not.toContain(id)
  })

  it('puts it back, for the one person who put it there', async () => {
    const id = await threadIn(team, 'Cheap desks 2')
    await spam.markThreadSpam(id, emma)
    expect(await listFor(emma)).not.toContain(id)

    await spam.unmarkThreadSpam(id, emma)
    expect(await listFor(emma)).toContain(id)
    expect(await binOf(emma, emma)).not.toContain(id)
  })

  it('files junk from a colleague’s own address in THEIR bin, not the coverer’s', async () => {
    const id = await threadIn(samBox, 'Cheap desks 3')

    // Marcus is covering Sam's post. The row goes to Sam.
    const owner = spam.spamOwnerFor({
      pressedByUserId: marcus,
      inbox: { kind: 'individual', ownerUserId: sam },
    })
    expect(owner).toBe(sam)
    await spam.markThreadSpam(id, owner)

    // It is in Sam's bin and in nobody else's.
    expect(await binOf(sam, sam)).toContain(id)
    expect(await binOf(marcus, marcus)).not.toContain(id)
    // And Marcus can still go and look at Sam's, which is the way back from a
    // mis-click while covering.
    expect(await binOf(marcus, sam)).toContain(id)
  })

  it('takes it off the coverer’s lists as well, because covering means seeing what they see', async () => {
    const id = await threadIn(samBox, 'Cheap desks 4')
    await spam.markThreadSpam(id, sam)

    expect(await listFor(sam)).not.toContain(id)
    // The half that a clause reading only the reader would get wrong: Marcus
    // has filed nothing, and it must still be gone from his view of Sam's post.
    expect(await listFor(marcus)).not.toContain(id)
  })

  it('keeps one person’s opinion of a SHARED address off everybody else', async () => {
    // The other half of the same clause, and the one that a rule written as
    // "hide anything any colleague binned" would get wrong. Sam owns an
    // address, so Sam appears in the owner half of the clause - but this
    // conversation is in the TEAM's address, where Sam's opinion is Sam's alone.
    const id = await threadIn(team, 'Cheap desks 5')
    await spam.markThreadSpam(id, sam)

    expect(await listFor(sam)).not.toContain(id)
    expect(await listFor(marcus)).toContain(id)
    expect(await listFor(emma)).toContain(id)
  })

  it('draws an empty folder for a bin that belongs to nobody, rather than the reader’s own', async () => {
    const id = await threadIn(team, 'Cheap desks 6')
    await spam.markThreadSpam(id, emma)

    // A folder scoped to a shared address, or to an id the reader may not open,
    // resolves to no owner. It must not fall back to Emma's own junk under a
    // heading with somebody else's name on it.
    expect(await binOf(emma, null)).toEqual([])
    // Absent is the other thing entirely, and still means "my own".
    expect(await binOf(emma, emma)).toContain(id)
  })

  it('counts the same way it lists, on the tallies and on the status tabs', async () => {
    const id = await threadIn(team, 'Cheap desks 7')

    const badge = async (reader: string): Promise<number> =>
      (await lib.openCounts(reader, [team, samBox], false, []))[team] ?? 0
    const counted = async (reader: string): Promise<number> => await lib.countThreads({
      viewerUserId: reader,
      inboxIds: [team, samBox],
      includeUnrouted: false,
      status: 'all',
      page: 1,
      perPage: 50,
    })

    const emmaBefore = await badge(emma)
    const marcusBefore = await badge(marcus)
    const emmaCountBefore = await counted(emma)

    await spam.markThreadSpam(id, emma)

    // Off Emma's badge and out of Emma's count; Marcus's badge is untouched.
    expect(await badge(emma)).toBe(emmaBefore - 1)
    expect(await counted(emma)).toBe(emmaCountBefore - 1)
    expect(await badge(marcus)).toBe(marcusBefore)

    // And the status tabs, which run the same clauses with the status left out.
    const statuses = await lib.statusCounts({
      viewerUserId: emma,
      inboxIds: [team, samBox],
      includeUnrouted: false,
      status: 'all',
      page: 1,
      perPage: 50,
    })
    expect(statuses.all).toBe(emmaCountBefore - 1)
  })

  it('marks the same conversation twice without complaining', async () => {
    // The pair is the primary key, so a double press - or two tabs racing - is
    // one row rather than a unique-violation the screen would have to explain.
    const id = await threadIn(team, 'Cheap desks 8')
    await spam.markThreadSpam(id, emma)
    await spam.markThreadSpam(id, emma)
    expect(await spam.threadIsSpamFor(id, emma)).toBe(true)
    // And taking it out of a bin it is not in is a Tuesday, not an error.
    await spam.unmarkThreadSpam(id, marcus)
    expect(await spam.threadIsSpamFor(id, emma)).toBe(true)
    expect(await spam.threadIsSpamFor(id, marcus)).toBe(false)
  })

  it('round-trips the block list, normalised on the way in', async () => {
    await blocked.blockSender('  Spam@Example.COM  ', emma)
    // Blocking somebody twice is blocking them once, and keeps the first row -
    // including who did it, which is the half worth having six months later.
    await blocked.blockSender('spam@example.com', marcus)

    const list = await blocked.listBlockedSenders()
    expect(list.map((row) => row.address)).toEqual(['spam@example.com'])
    expect(list[0]!.blockedByUserId).toBe(emma)

    expect(await blocked.isSenderBlocked('SPAM@EXAMPLE.COM')).toBe(true)
    expect(await blocked.isSenderBlocked('customer@example.com')).toBe(false)
    expect([...(await blocked.blockedSenderSet())]).toEqual(['spam@example.com'])

    await blocked.unblockSender('Spam@Example.com')
    expect(await blocked.isSenderBlocked('spam@example.com')).toBe(false)
    expect(await blocked.listBlockedSenders()).toEqual([])
  })

  it('puts post from a blocked sender in the bin for everybody, done and unread', async () => {
    // Nobody pressed anything. The collecting pass stamps the conversation
    // because the address is on the site's list, and a block is a fact about
    // the site rather than one person's view of one conversation - so it has to
    // be out of EVERY list rather than out of whichever colleague's the pass
    // happened to guess at. There is nobody to guess at either: the person who
    // blocked the address may have left months ago.
    const id = await threadIn(team, 'Cheap desks 10')
    await lib.setThreadBlocked(id, true)

    expect(await stateOf(id)).toEqual({ status: 'done', unread: true, blocked: true })

    // Out of both readers' ordinary lists, neither of whom has an opinion.
    expect(await listFor(emma)).not.toContain(id)
    expect(await listFor(marcus)).not.toContain(id)
    // And in both of their bins, which is where the two clauses part company
    // with everything else in this file: a per-person mark shows in one bin,
    // this shows in every real one.
    expect(await binOf(emma, emma)).toContain(id)
    expect(await binOf(marcus, marcus)).toContain(id)
    // The header offers "Not junk" rather than "Junk", for anybody. Without
    // this the one conversation nobody put in the folder would be the one
    // nobody could take out of it.
    expect(await spam.threadIsSpamFor(id, emma)).toBe(true)
    expect(await spam.threadIsSpamFor(id, marcus)).toBe(true)
  })

  it('leaves a bin belonging to nobody empty, even of blocked post', async () => {
    // Claim 4 read once more against the new clause. A folder scoped to a
    // shared address, or to an id this reader may not open, resolves to null
    // and must yield nothing AT ALL - "nothing except the interesting part" is
    // exactly how a scope that will not resolve starts leaking.
    const id = await threadIn(team, 'Cheap desks 11')
    await lib.setThreadBlocked(id, true)
    expect(await binOf(emma, null)).not.toContain(id)
  })

  it('stamps a conversation once, however many times they write', async () => {
    // A nuisance who writes six times is one conversation carrying the day they
    // first got through, not one whose date creeps forward every tick.
    const id = await threadIn(team, 'Cheap desks 12')
    await lib.setThreadBlocked(id, true)
    const [first] = await db.$queryRawUnsafe<{ blocked_at: Date }[]>(
      `SELECT "blocked_at" FROM "uin_threads" WHERE "id" = $1`, id,
    )
    await lib.setThreadBlocked(id, true)
    const [second] = await db.$queryRawUnsafe<{ blocked_at: Date }[]>(
      `SELECT "blocked_at" FROM "uin_threads" WHERE "id" = $1`, id,
    )
    expect(second!.blocked_at.getTime()).toBe(first!.blocked_at.getTime())
  })

  it('lets “Not junk” rescue one, and leaves the sender blocked', async () => {
    // The only way out of the folder, so it is the one that must not break. It
    // comes back OPEN rather than done, because the done was the site's
    // housekeeping and not anybody's decision that the matter was finished.
    const id = await threadIn(team, 'Cheap desks 13')
    await blocked.blockSender('nuisance@example.com', emma)
    await lib.setThreadBlocked(id, true)
    expect(await listFor(marcus)).not.toContain(id)

    await lib.setThreadBlocked(id, false)

    expect(await stateOf(id)).toEqual({ status: 'open', unread: true, blocked: false })
    expect(await listFor(emma)).toContain(id)
    expect(await listFor(marcus)).toContain(id)
    expect(await binOf(emma, emma)).not.toContain(id)
    // Letting one conversation through is not opening the front door.
    expect(await blocked.isSenderBlocked('nuisance@example.com')).toBe(true)
    await blocked.unblockSender('nuisance@example.com')
  })

  it('counts blocked post the same way it lists it', async () => {
    // The tallies carry their own copy of the junk clause, and a number that
    // disagrees with the list behind it is the defect a spam folder must not
    // have - the one that has somebody hunting for a message that is not there.
    const id = await threadIn(team, 'Cheap desks 14')
    const before = await lib.countThreads({
      viewerUserId: marcus, inboxIds: [team, samBox], includeUnrouted: false, status: 'all',
      page: 1, perPage: 50,
    })
    await lib.setThreadBlocked(id, true)
    const after = await lib.countThreads({
      viewerUserId: marcus, inboxIds: [team, samBox], includeUnrouted: false, status: 'all',
      page: 1, perPage: 50,
    })
    expect(after).toBe(before - 1)

    const bin = await lib.countThreads({
      viewerUserId: marcus,
      spamOnly: true,
      spamOwnerUserId: marcus,
      inboxIds: [team, samBox],
      includeUnrouted: false,
      status: 'all',
      page: 1,
      perPage: 50,
    })
    expect(bin).toBe((await binOf(marcus, marcus)).length)
  })

  it('takes a colleague’s junk marks with them when their account goes', async () => {
    // ON DELETE CASCADE on the user side, which is the one place this module
    // does not use SET NULL: a junk mark IS a person's opinion, and there is
    // nobody left to hold it. Left behind, it would go on hiding conversations
    // from everybody covering an address that person used to own.
    const id = await threadIn(team, 'Cheap desks 9')
    await db.$executeRawUnsafe(
      `INSERT INTO "User" ("id", "email", "username", "roleId", "updatedAt")
       VALUES ('user-leaver', 'leaver@deskwell.co.uk', 'leaver', 'role-staff', now())`,
    )
    await spam.markThreadSpam(id, 'user-leaver')
    expect(await spam.threadIsSpamFor(id, 'user-leaver')).toBe(true)

    await db.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = 'user-leaver'`)
    expect(await spam.threadIsSpamFor(id, 'user-leaver')).toBe(false)
    // And the conversation itself is untouched - nothing here deletes post.
    expect(await listFor(emma)).toContain(id)
  })
})
