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
// Moving a conversation to another mailbox, against a real database.
//
// `moveThreadToInbox` is three statements in a transaction and every one of
// them is a template string as far as `tsc`, `eslint`, `npm test` and the build
// gate are concerned. These are the claims it makes:
//
//   1. The conversation is listed under the mailbox it was moved to, and no
//      longer under the one it left.
//   2. Its home column is the new mailbox - which is what a reply is sent from,
//      because `prepareSend` falls back to it when the writing box names none.
//   3. A MERGED conversation, listed under every address it absorbed, leaves all
//      of them. One dragged out of sales@ that still showed in sales@ through a
//      side row would read as the move not having worked.
//   4. Its unsent drafts come with it. A draft files by the mailbox it carries
//      and a scheduled one is checked against it before it goes.
//   5. Its messages do NOT move. Which address a message left from is history.
//   6. The next collection does not put it back: the roll-forward after new mail
//      lands keeps a home that is already set.
//   7. A conversation that is not there answers null rather than throwing.
//
// A real throwaway database on the Postgres VPS, built from the core schema and
// this module's own migrations. Named `cactus_rt_*` and dropped afterwards; the
// live site's database sits on the same server and is never named, opened or
// altered.
//
// Skipped unless opted into, so a plain `npm test` never touches the network:
//
//   RUN_INBOX_MOVE_GUARDS=1 npx vitest run \
//     modules/unified-inbox/lib/thread-move.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_MOVE_GUARDS === '1'
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

describe.runIf(shouldRun)('moving a conversation to another mailbox, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: Db

  let sales = ''
  let support = ''
  let accounts = ''

  const emma = 'user-emma'

  const listUnder = async (inboxId: string): Promise<string[]> => (
    await lib.listThreads({
      viewerUserId: emma,
      inboxIds: [sales, support, accounts],
      inboxId,
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
    database = await createTestDatabase(vps, `cactus_rt_uinmove_${stamp}`, role)
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

    // A real person: a draft carries a foreign key to its author.
    await db.$executeRawUnsafe(`INSERT INTO "Role" ("id", "name") VALUES ('role-staff', 'Staff')`)
    await db.$executeRawUnsafe(
      `INSERT INTO "User" ("id", "email", "username", "roleId", "updatedAt")
       VALUES ($1, 'emma@deskwell.co.uk', 'emma', 'role-staff', now())`,
      emma,
    )

    sales = (await lib.createInbox({ name: 'Sales', address: 'sales@deskwell.co.uk' })).id
    support = (await lib.createInbox({ name: 'Support', address: 'support@deskwell.co.uk' })).id
    accounts = (await lib.createInbox({ name: 'Accounts', address: 'accounts@deskwell.co.uk' })).id
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('lists it under the mailbox it was moved to, and sends from there', async () => {
    const id = await threadIn(sales, 'Eight desks')
    expect(await listUnder(sales)).toContain(id)

    const moved = await lib.moveThreadToInbox(id, support)
    expect(moved).toEqual({ fromInboxId: sales })

    expect(await listUnder(support)).toContain(id)
    expect(await listUnder(sales)).not.toContain(id)
    // The column a reply is sent from.
    expect((await lib.getThread(id))?.inboxId).toBe(support)
  })

  it('takes a merged conversation out of every address it had absorbed', async () => {
    const id = await threadIn(sales, 'Eight desks, merged')
    // What a merge leaves behind: a row per address it is listed under.
    await db.$executeRawUnsafe(
      `INSERT INTO "uin_thread_inboxes" ("thread_id", "inbox_id") VALUES ($1, $2), ($1, $3)`,
      id, sales, accounts,
    )
    expect(await listUnder(accounts)).toContain(id)

    await lib.moveThreadToInbox(id, support)

    expect(await listUnder(support)).toContain(id)
    expect(await listUnder(sales)).not.toContain(id)
    expect(await listUnder(accounts)).not.toContain(id)
  })

  it('brings its unsent drafts and leaves its messages where they were', async () => {
    const id = await threadIn(sales, 'Eight desks, half answered')
    await db.$executeRawUnsafe(
      `INSERT INTO "uin_drafts" ("author_user_id", "inbox_id", "thread_id", "mode", "body")
       VALUES ($1, $2, $3, 'reply', 'Dear Sam,')`,
      emma, sales, id,
    )
    // A draft on some OTHER conversation in sales@, which must not come along.
    const other = await threadIn(sales, 'Somebody else entirely')
    await db.$executeRawUnsafe(
      `INSERT INTO "uin_drafts" ("author_user_id", "inbox_id", "thread_id", "mode", "body")
       VALUES ($1, $2, $3, 'reply', 'Dear Alex,')`,
      emma, sales, other,
    )
    await db.$executeRawUnsafe(
      `INSERT INTO "uin_messages" ("thread_id", "inbox_id", "direction", "from_address", "sent_at")
       VALUES ($1, $2, 'out', 'sales@deskwell.co.uk', now())`,
      id, sales,
    )

    await lib.moveThreadToInbox(id, support)

    const drafts = await db.$queryRawUnsafe<{ thread_id: string; inbox_id: string }[]>(
      `SELECT "thread_id", "inbox_id" FROM "uin_drafts" WHERE "thread_id" IN ($1, $2)`,
      id, other,
    )
    expect(drafts.find((d) => d.thread_id === id)?.inbox_id).toBe(support)
    expect(drafts.find((d) => d.thread_id === other)?.inbox_id).toBe(sales)

    const messages = await db.$queryRawUnsafe<{ inbox_id: string }[]>(
      `SELECT "inbox_id" FROM "uin_messages" WHERE "thread_id" = $1`,
      id,
    )
    expect(messages.map((m) => m.inbox_id)).toEqual([sales])
  })

  it('is not put back by new mail arriving at the old address', async () => {
    const id = await threadIn(sales, 'Eight desks, still going')
    await lib.moveThreadToInbox(id, support)

    // What the collection does after filing a new message on the conversation,
    // naming the address the message ARRIVED at.
    await lib.touchThread(id, {
      sentAt: new Date('2026-09-02T09:00:00Z'),
      direction: 'in',
      preview: 'One more thing',
      subject: 'Eight desks, still going',
      subjectNormalised: 'eight desks, still going',
      markUnread: true,
      inboxId: sales,
      arrivedNow: true,
    })

    expect((await lib.getThread(id))?.inboxId).toBe(support)
    expect(await listUnder(sales)).not.toContain(id)
  })

  it('answers null for a conversation that is not there', async () => {
    expect(await lib.moveThreadToInbox('no-such-thread', support)).toBeNull()
  })
})
