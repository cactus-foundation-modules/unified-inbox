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
// One person's own desk, executed.
//
// Everything this covers is raw SQL, and NOTHING else in this repository runs
// it: `tsc` sees a template string, `eslint` sees a template string, a build
// never executes a query, and the module build gate compiles rather than
// connects. A query Postgres will not parse is green everywhere until a
// customer opens the screen.
//
// Five claims, and every one of them is about the DATABASE:
//
//   1. `assignThreadIfUnassigned` fills an empty desk and REFUSES an occupied
//      one, in one statement. Two collection ticks land on one conversation at
//      once; a read followed by a write would let the second take it off the
//      person the first gave it to, and the whole guard is a WHERE clause that
//      no typechecker executes.
//   2. `alsoAssignedTo` widens the address somebody opens on to take in the
//      work handed to them elsewhere - and widens NOTHING ELSE. The visibility
//      clause is a separate AND, so a conversation in an inbox this reader may
//      not open stays invisible even when it carries their name. That is E17,
//      and it is the claim worth running rather than reading.
//   3. `openAssignedElsewhere` counts exactly what the list above shows and
//      not the rows already under their own address. A number beside an address
//      that disagrees with the list under it sends somebody hunting for a
//      message that was never missing.
//   4. The Unassigned queue on a shared address means open AND on nobody's
//      desk, in one clause, and the number on the tab agrees with the list
//      under it. A count drawn from a different WHERE than its list is a tab
//      that says three and shows one.
//   5. `railOrderFor` / `setRailOrder` round-trip, including the `::text[]`
//      cast and the ON CONFLICT - saved twice is one row, not two.
//
// A real throwaway database on the Postgres VPS, built from the core schema and
// this module's own migrations. Named `cactus_rt_*` and dropped afterwards; the
// live site's database sits on the same server and is never named, opened or
// altered.
//
// Skipped unless opted into, so a plain `npm test` never touches the network:
//
//   RUN_INBOX_OWN_DESK=1 npx vitest run \
//     modules/unified-inbox/lib/own-desk.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_OWN_DESK === '1'
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

describe.runIf(shouldRun)('one person’s own desk, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: Db

  const emma = 'user-emma'
  const marcus = 'user-marcus'

  /** Emma's own address, the team's, and one she is not on. */
  let emmaInbox = ''
  let accounts = ''
  let secret = ''

  /** Everything Emma may read. `secret` is deliberately absent. */
  const visible = () => [emmaInbox, accounts]

  const thread = async (inboxId: string, subject: string): Promise<string> => (
    lib.createThread({
      inboxId,
      subject,
      subjectNormalised: subject.toLowerCase(),
      preview: subject,
      lastMessageAt: new Date('2026-09-01T10:00:00Z'),
      lastDirection: 'in',
      unread: true,
    })
  )

  const listFor = async (extra: Record<string, unknown>): Promise<string[]> => {
    const rows = await lib.listThreads({
      viewerUserId: emma,
      inboxIds: visible(),
      includeUnrouted: false,
      status: 'all',
      page: 1,
      perPage: 25,
      ...extra,
    })
    return rows.map((r) => r.subject ?? '').sort()
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
    database = await createTestDatabase(vps, `cactus_rt_uindesk_${stamp}`, role)
    process.env.DATABASE_URL = database.connectionUri
    process.env.ENCRYPTION_KEY = KEY

    const { stalePlanRetryExtension } = await import('@/lib/db/prisma')
    const { splitSqlStatements } = await import('@/lib/backup/restore')
    db = await connect(database.connectionUri, stalePlanRetryExtension)

    const applyFile = async (file: string) => {
      for (const statement of splitSqlStatements(readFileSync(file, 'utf8'))) {
        await db.$executeRawUnsafe(statement)
      }
    }
    await applyFile(CORE_SCHEMA)
    for (const file of readdirSync(MODULE_MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      await applyFile(path.join(MODULE_MIGRATIONS, file))
    }

    lib = await import('./db')

    // Two real people: the foreign keys to "User" are part of what is tested.
    await db.$executeRawUnsafe(`INSERT INTO "Role" ("id", "name") VALUES ('role-staff', 'Staff')`)
    for (const [id, email, username] of [
      [emma, 'emma@deskwell.co.uk', 'emma'],
      [marcus, 'marcus@deskwell.co.uk', 'marcus'],
    ]) {
      await db.$executeRawUnsafe(
        `INSERT INTO "User" ("id", "email", "username", "roleId", "updatedAt")
         VALUES ($1, $2, $3, 'role-staff', now())`,
        id, email, username,
      )
    }

    emmaInbox = (await lib.createInbox({
      name: 'Emma', address: 'emma@deskwell.co.uk', kind: 'individual', ownerUserId: emma,
    })).id
    accounts = (await lib.createInbox({ name: 'Accounts', address: 'accounts@deskwell.co.uk' })).id
    secret = (await lib.createInbox({ name: 'Board', address: 'board@deskwell.co.uk' })).id
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('fills an empty desk, and will not take a conversation off somebody who has it', async () => {
    const post = await thread(emmaInbox, 'Her own post')

    expect(await lib.assignThreadIfUnassigned(post, emma)).toBe(true)
    // The second tick arrives. Emma keeps it, and the answer says so.
    expect(await lib.assignThreadIfUnassigned(post, marcus)).toBe(false)
    expect((await lib.getThreadDetail(post))?.assigneeUserId).toBe(emma)

    // And once somebody deliberately hands it back, it is free again.
    await lib.assignThread(post, null)
    expect(await lib.assignThreadIfUnassigned(post, marcus)).toBe(true)
    expect((await lib.getThreadDetail(post))?.assigneeUserId).toBe(marcus)
  })

  it('shows what was handed to her in her own address, wherever it was filed', async () => {
    const hers = await thread(emmaInbox, 'Ordinary post at her own address')
    const handed = await thread(accounts, 'Handed to Emma in accounts')
    const somebody = await thread(accounts, 'Handed to Marcus in accounts')
    await lib.assignThread(handed, emma)
    await lib.assignThread(somebody, marcus)

    expect(await listFor({ inboxId: emmaInbox, alsoAssignedTo: emma })).toEqual([
      'Handed to Emma in accounts',
      'Her own post',
      'Ordinary post at her own address',
    ])

    // Without the widening it is her address and nothing else, which is what
    // every other address on the rail still does.
    expect(await listFor({ inboxId: emmaInbox })).toEqual([
      'Her own post',
      'Ordinary post at her own address',
    ])

    // And accounts@ has lost nothing: the conversation is still there, still in
    // its own list, for everybody who reads it.
    expect(await listFor({ inboxId: accounts })).toEqual([
      'Handed to Emma in accounts',
      'Handed to Marcus in accounts',
    ])
  })

  it('never reaches into an address she may not open, even carrying her name', async () => {
    const locked = await thread(secret, 'Something on the board address')
    await lib.assignThread(locked, emma)

    // E17: the visibility clause is a separate AND, so the widening cannot
    // widen past it.
    expect(await listFor({ inboxId: emmaInbox, alsoAssignedTo: emma }))
      .not.toContain('Something on the board address')
    expect(await lib.countThreads({
      viewerUserId: emma,
      inboxIds: visible(),
      includeUnrouted: false,
      inboxId: emmaInbox,
      alsoAssignedTo: emma,
      status: 'all',
      page: 1,
      perPage: 25,
    })).toBe(3)
  })

  it('counts the desk, and counts only what is filed somewhere else', async () => {
    const count = () => lib.openAssignedElsewhere(emma, visible(), false, [], emmaInbox)

    // One conversation in accounts@ is hers and open. The one on the board
    // address carries her name and is not hers to see; the ones in her own
    // address are already under it.
    expect(await count()).toBe(1)

    const hers = '' + (await lib.listThreads({
      viewerUserId: emma,
      inboxIds: visible(),
      includeUnrouted: false,
      inboxId: accounts,
      assignee: emma,
      status: 'all',
      page: 1,
      perPage: 25,
    }))[0]!.id

    // Reading it does NOT take it off the number, and that is the whole point of
    // counting open ones rather than unread ones: a job somebody has looked at
    // and not finished is still a job on their desk. The old count went to
    // nothing the moment they glanced at it, which made the rail read as an
    // empty desk all afternoon.
    await lib.setThreadRead(hers, false)
    expect(await count()).toBe(1)

    // Finishing it is what takes it off, exactly as it takes it off the address
    // it sits in.
    await lib.setThreadStatus(hers, 'done', null)
    expect(await count()).toBe(0)
  })

  it('offers the queue on a shared address: open, and on nobody’s desk', async () => {
    // The Unassigned tab is not the assignee filter wearing a hat - it is its
    // own value in the status slot, and both halves of what it means live in
    // one WHERE clause that nothing else in this repository executes. The tab,
    // the number on it and the paging under it all come through here, so a
    // clause Postgres will not parse takes the whole column down rather than
    // only the tab.
    const waiting = await thread(accounts, 'Nobody has taken this')
    const taken = await thread(accounts, 'Marcus has this one')
    const settled = await thread(accounts, 'Finished and on nobody’s desk')
    await lib.assignThread(taken, marcus)
    await lib.setThreadStatus(settled, 'done', null)
    expect(waiting).toBeTruthy()

    // Open and unassigned, and neither of the other two.
    expect(await listFor({ inboxId: accounts, status: 'unassigned' }))
      .toEqual(['Nobody has taken this'])

    // The count beside the tab says the same thing as the list under it, which
    // is the disagreement worth executing rather than reading. `all` is every
    // status once: the queue is a cut across the open ones, so counting it in
    // would count each of them twice.
    const counts = await lib.statusCounts({
      viewerUserId: emma,
      inboxIds: visible(),
      includeUnrouted: false,
      inboxId: accounts,
      status: 'all',
      page: 1,
      perPage: 25,
    })
    const open = counts.open ?? 0
    expect(counts.unassigned).toBe(1)
    expect(counts.all).toBe(open + (counts.done ?? 0) + (counts.snoozed ?? 0))

    // And it pages and counts through the same clause the list came out of.
    expect(await lib.countThreads({
      viewerUserId: emma,
      inboxIds: visible(),
      includeUnrouted: false,
      inboxId: accounts,
      status: 'unassigned',
      page: 1,
      perPage: 25,
    })).toBe(1)

    // Put it on somebody and it leaves the queue, which is the whole point of
    // the tab: it empties as the morning is worked through.
    await lib.assignThread(waiting, emma)
    expect(await listFor({ inboxId: accounts, status: 'unassigned' })).toEqual([])
  })

  it('keeps the top of the rail in her own order, and saving twice is one row', async () => {
    expect(await lib.railOrderFor(emma)).toEqual([])

    await lib.setRailOrder(emma, [emmaInbox, 'sent', 'all'])
    expect(await lib.railOrderFor(emma)).toEqual([emmaInbox, 'sent', 'all'])

    await lib.setRailOrder(emma, ['all', emmaInbox])
    expect(await lib.railOrderFor(emma)).toEqual(['all', emmaInbox])

    const rows = await db.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS "count" FROM "uin_user_rail_order" WHERE "user_id" = $1`,
      emma,
    )
    expect(Number(rows[0]!.count)).toBe(1)

    // One person's order is one person's. Nobody else has one.
    expect(await lib.railOrderFor(marcus)).toEqual([])
  })
})
