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
// A reply cancels a snooze, executed.
//
// `wakeSnoozedThread` is raw SQL, and raw SQL is a string to `tsc`, a string to
// `eslint`, and never executed by a build - so a statement Postgres will not
// parse, or one whose WHERE clause is a shade too wide, passes every gate this
// repository has. The gate it must not pass is a conversation somebody marked
// DONE quietly reappearing in Open every time a bounce lands on it.
//
// A real throwaway database on the Postgres VPS, built from the core schema and
// this module's own migrations. Named `cactus_rt_*` and dropped afterwards; the
// live site's database sits on the same server and is never named, opened or
// altered.
//
// Skipped unless opted into, so a plain `npm test` never touches the network:
//
//   RUN_INBOX_SNOOZE_GUARDS=1 npx vitest run \
//     modules/unified-inbox/lib/snooze-wake.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_SNOOZE_GUARDS === '1'
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

describe.runIf(shouldRun)('a reply cancels a snooze, against a real database', () => {
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
    database = await createTestDatabase(vps, `cactus_rt_uinsnz_${stamp}`, role)
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

    expect(await lib.wakeSnoozedThread(id)).toBe(true)

    // Status and snooze move together. A conversation left 'open' with a stamp
    // on it is the bug wakeDueThreads exists to avoid re-creating.
    expect(await stateOf(id)).toEqual({ status: 'open', snoozeUntil: null })
  })

  it('says no the second time, so two ticks racing write one timeline entry', async () => {
    const id = await threadIn('snoozed', THURSDAY)
    expect(await lib.wakeSnoozedThread(id)).toBe(true)
    expect(await lib.wakeSnoozedThread(id)).toBe(false)
  })

  it('leaves a conversation somebody marked done exactly where they left it', async () => {
    const id = await threadIn('done')
    expect(await lib.wakeSnoozedThread(id)).toBe(false)
    expect(await stateOf(id)).toMatchObject({ status: 'done' })
  })

  it('does not rewrite one that was already open', async () => {
    const id = await threadIn('open')
    expect(await lib.wakeSnoozedThread(id)).toBe(false)
    expect(await stateOf(id)).toEqual({ status: 'open', snoozeUntil: null })
  })

  it('touches nothing but the conversation it was given', async () => {
    const woken = await threadIn('snoozed', THURSDAY)
    const bystander = await threadIn('snoozed', THURSDAY)

    expect(await lib.wakeSnoozedThread(woken)).toBe(true)

    expect(await stateOf(bystander)).toMatchObject({ status: 'snoozed' })
  })

  it('writes the timeline entry with nobody attached to it', async () => {
    const id = await threadIn('snoozed', THURSDAY)
    await lib.wakeSnoozedThread(id)
    // user_id is a foreign key to User with ON DELETE SET NULL. Nobody did this,
    // so it goes in null - and the column has to actually accept that.
    await lib.recordEvent(id, null, 'woken', { direction: 'in' })

    const events = await lib.listThreadEvents(id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'woken', userId: null, detail: { direction: 'in' } })
  })

  it('puts it back in the list the Open tab draws', async () => {
    const id = await threadIn('snoozed', THURSDAY)
    const open = () => lib.listThreads({
      inboxIds: [inboxId], includeUnrouted: false, status: 'open', page: 1, perPage: 50,
    })

    expect((await open()).map((t) => t.id)).not.toContain(id)

    await lib.wakeSnoozedThread(id)

    expect((await open()).map((t) => t.id)).toContain(id)
  })
})
