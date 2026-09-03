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
// A reply puts a conversation back in Open, executed.
//
// `reopenOnReply` is raw SQL, and raw SQL is a string to `tsc`, a string to
// `eslint`, and never executed by a build - so a statement Postgres will not
// parse, or one whose WHERE clause is a shade too wide, passes every gate this
// repository has. This one is also the least ordinary statement in the module:
// a CTE that reads the status under FOR UPDATE and an UPDATE ... FROM that
// returns it, because plain RETURNING would hand back the value just written.
// Whether Postgres agrees is not a thing to find out on a customer's site.
//
// A real throwaway database on the Postgres VPS, built from the core schema and
// this module's own migrations. Named `cactus_rt_*` and dropped afterwards; the
// live site's database sits on the same server and is never named, opened or
// altered.
//
// Skipped unless opted into, so a plain `npm test` never touches the network:
//
//   RUN_INBOX_REOPEN_GUARDS=1 npx vitest run \
//     modules/unified-inbox/lib/reopen-on-reply.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_REOPEN_GUARDS === '1'
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

const SENT_AT = new Date('2026-09-03T09:14:00.000Z')
const THURSDAY = new Date('2026-09-10T08:00:00.000Z')

describe.runIf(shouldRun)('a reply puts a conversation back in Open, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: Db

  let inboxId = ''

  /** A fresh conversation in whatever state the test needs it in. */
  const threadIn = async (
    status: 'open' | 'snoozed' | 'done',
    snoozeUntil: Date | null = null,
  ): Promise<string> => {
    const id = await lib.createThread({
      inboxId,
      subject: 'Two of the Artisan desks',
      subjectNormalised: 'two of the artisan desks',
      preview: 'Could you hold them until the office move?',
      lastMessageAt: SENT_AT,
      lastDirection: 'in',
      unread: true,
    })
    if (status !== 'open') await lib.setThreadStatus(id, status, snoozeUntil)
    return id
  }

  /** Read straight off the row rather than through getThread, which does not
   *  carry the stamp: the pair moving together is half of what is under test. */
  const stateOf = async (id: string): Promise<{ status: string; snoozeUntil: Date | null }> => {
    const rows = await db.$queryRaw<{ status: string; snooze_until: Date | null }[]>`
      SELECT "status", "snooze_until" FROM "uin_threads" WHERE "id" = ${id}
    `
    const row = rows[0]
    if (!row) throw new Error(`no conversation ${id}`)
    return { status: row.status, snoozeUntil: row.snooze_until }
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
    database = await createTestDatabase(vps, `cactus_rt_uinreo_${stamp}`, role)
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

    const connection = await lib.createConnection({
      label: 'iCloud',
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapUsername: 'someone@example.com',
      imapPassword: 'nothing-real',
    })
    inboxId = (await lib.createInbox({
      name: 'Sales', address: 'sales@deskwell.co.uk', connectionId: connection.id,
    })).id
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('opens a sleeping conversation and clears the stamp with it', async () => {
    const id = await threadIn('snoozed', THURSDAY)
    expect(await stateOf(id)).toMatchObject({ status: 'snoozed' })

    expect(await lib.reopenOnReply(id)).toBe('snoozed')

    // Status and snooze move together. A conversation left 'open' with a stamp
    // on it is the bug wakeDueThreads exists to avoid re-creating.
    expect(await stateOf(id)).toEqual({ status: 'open', snoozeUntil: null })
  })

  it('opens one somebody had finished with, and says that is what it was', async () => {
    const id = await threadIn('done')

    // The whole reason the caller wants the old status back: the conversation
    // is identical afterwards either way, and only this says which sentence the
    // timeline should carry.
    expect(await lib.reopenOnReply(id)).toBe('done')
    expect(await stateOf(id)).toEqual({ status: 'open', snoozeUntil: null })
  })

  it('says nothing the second time, so two ticks write one timeline entry', async () => {
    const snoozed = await threadIn('snoozed', THURSDAY)
    expect(await lib.reopenOnReply(snoozed)).toBe('snoozed')
    expect(await lib.reopenOnReply(snoozed)).toBeNull()

    const done = await threadIn('done')
    expect(await lib.reopenOnReply(done)).toBe('done')
    expect(await lib.reopenOnReply(done)).toBeNull()
  })

  it('does not rewrite one that was already open', async () => {
    const id = await threadIn('open')
    expect(await lib.reopenOnReply(id)).toBeNull()
    expect(await stateOf(id)).toEqual({ status: 'open', snoozeUntil: null })
  })

  it('touches nothing but the conversation it was given', async () => {
    const reopened = await threadIn('snoozed', THURSDAY)
    const sleeping = await threadIn('snoozed', THURSDAY)
    const finished = await threadIn('done')

    expect(await lib.reopenOnReply(reopened)).toBe('snoozed')

    expect(await stateOf(sleeping)).toMatchObject({ status: 'snoozed' })
    expect(await stateOf(finished)).toMatchObject({ status: 'done' })
  })

  it('writes the timeline entry with nobody attached to it', async () => {
    const id = await threadIn('done')
    const was = await lib.reopenOnReply(id)
    // user_id is a foreign key to User with ON DELETE SET NULL. Nobody did this,
    // so it goes in null - and the column has to actually accept that.
    await lib.recordEvent(id, null, 'woken', { was, direction: 'in' })

    const events = await lib.listThreadEvents(id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'woken', userId: null, detail: { was: 'done', direction: 'in' },
    })
  })

  it('moves it out of the tab it was under and into Open', async () => {
    const listed = (status: 'open' | 'snoozed' | 'done') => lib.listThreads({
      inboxIds: [inboxId], includeUnrouted: false, status, page: 1, perPage: 50,
    }).then((rows) => rows.map((t) => t.id))

    const snoozed = await threadIn('snoozed', THURSDAY)
    const done = await threadIn('done')

    expect(await listed('snoozed')).toContain(snoozed)
    expect(await listed('done')).toContain(done)
    expect(await listed('open')).toEqual(expect.not.arrayContaining([snoozed, done]))

    await lib.reopenOnReply(snoozed)
    await lib.reopenOnReply(done)

    expect(await listed('open')).toEqual(expect.arrayContaining([snoozed, done]))
    expect(await listed('snoozed')).not.toContain(snoozed)
    expect(await listed('done')).not.toContain(done)
  })

  it('counts a reopened conversation on the badge again, which done ones are not', async () => {
    // unreadCounts skips done conversations on purpose. That is precisely why a
    // reply to a finished one had to reopen it rather than merely mark it
    // unread: unread and done is unread and invisible.
    const badge = async () => (await lib.unreadCounts([inboxId], false))[inboxId] ?? 0

    // A delta rather than an absolute: the tests above share this database and
    // have left their own reopened conversations lying about in it.
    const before = await badge()
    const id = await threadIn('done')
    expect(await badge()).toBe(before)

    await lib.reopenOnReply(id)

    expect(await badge()).toBe(before + 1)
  })
})
