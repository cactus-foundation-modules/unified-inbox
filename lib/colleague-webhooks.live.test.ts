import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
// Type only, and everything else that would reach the shared Prisma client is
// imported inside beforeAll: that client is built the first time it is imported
// and reads DATABASE_URL as it goes.
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
import type { WebhookEvent } from './webhook-types'

// ---------------------------------------------------------------------------
// The colleague webhook SQL, executed.
//
// The rules about who hears what are pure and tested in
// colleague-webhooks.test.ts. What only a database can prove is everything
// around them: that the message row reads (the filed-inbox subquery, the
// discussion columns), that the scoped subscription query parses, that the
// newest-post pick works, and above all that migration 057's index really does
// stop one subscription being told about one email twice - once when it lands
// and again when it is handed over a moment later.
//
// A real throwaway database on the Postgres VPS, named `cactus_rt_*` and
// dropped afterwards; the live site's database on the same server is never
// named, opened or altered. Run it from the core checkout with
// OVH_SERVER/OVH_USER/OVH_PASSWORD exported from the Deskwell workspace .env:
//
//   RUN_INBOX_WEBHOOK_GUARDS=1 npx vitest run \
//     modules/unified-inbox/lib/colleague-webhooks.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_WEBHOOK_GUARDS === '1'
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

type Colleague = typeof import('./colleague-webhooks')
type Arrival = typeof import('./webhooks')
type Hooks = typeof import('./webhooks-db')
type Db = typeof import('./db')

const chris = 'user-chris'
const bob = 'user-bob'
const carol = 'user-carol'

describe.runIf(shouldRun)('colleague webhooks against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let colleague: Colleague
  let arrival: Arrival
  let hooks: Hooks
  let lib: Db

  let bobInbox: string
  let carolInbox: string
  let sales: string
  let bobHook: string
  let carolHook: string
  let salesHook: string
  let everyHook: string
  let emailThread: string
  let firstEmail: string

  /** What has been queued for one subscription, oldest first. */
  async function queued(webhookId: string) {
    return db.$queryRawUnsafe<{ event: string; message_id: string | null; payload: Record<string, unknown> }[]>(
      `SELECT "event", "message_id", "payload" FROM "uin_webhook_deliveries"
        WHERE "webhook_id" = $1 ORDER BY "created_at", "id"`,
      webhookId,
    )
  }

  async function inbound(threadId: string, subject: string, sentAt: string): Promise<string> {
    const rows = await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "uin_messages"
         ("thread_id", "direction", "channel", "from_name", "from_address", "subject", "snippet", "body_text", "sent_at")
       VALUES ($1, 'in', 'email', 'A Customer', 'customer@example.com', $2, 'Hello', 'Hello there', $3::timestamp)
       RETURNING "id"`,
      threadId, subject, sentAt,
    )
    return rows[0]!.id
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
    database = await createTestDatabase(vps, `cactus_rt_uincolhooks_${stamp}`, role)
    process.env.DATABASE_URL = database.connectionUri
    process.env.ENCRYPTION_KEY = KEY
    process.env.SITE_URL = 'https://example.com'

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

    colleague = await import('./colleague-webhooks')
    arrival = await import('./webhooks')
    hooks = await import('./webhooks-db')
    lib = await import('./db')

    await db.$executeRawUnsafe(`INSERT INTO "Role" ("id", "name") VALUES ('role-staff', 'Staff')`)
    for (const [id, email, username] of [
      [chris, 'chris@example.com', 'chris'],
      [bob, 'bob@example.com', 'bob'],
      [carol, 'carol@example.com', 'carol'],
    ]) {
      await db.$executeRawUnsafe(
        `INSERT INTO "User" ("id", "email", "username", "roleId", "updatedAt")
         VALUES ($1, $2, $3, 'role-staff', now())`,
        id, email, username,
      )
    }

    const inbox = async (name: string, address: string, owner: string | null) => {
      const rows = await db.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO "uin_inboxes" ("name", "address", "kind", "owner_user_id")
         VALUES ($1, $2, $3, $4) RETURNING "id"`,
        name, address, owner ? 'individual' : 'shared', owner,
      )
      return rows[0]!.id
    }
    bobInbox = await inbox('Bob', 'bob@example.com', bob)
    carolInbox = await inbox('Carol', 'carol@example.com', carol)
    sales = await inbox('Sales', 'sales@example.com', null)

    const hook = async (name: string, inboxId: string | null, events: WebhookEvent[]) => (await hooks.createWebhook({
      name,
      inboxId,
      url: `https://example.com/${name}`,
      events,
      payloadStyle: 'event',
      secretSource: 'none',
      headersSource: 'none',
    })).id
    bobHook = await hook('bob', bobInbox, ['message.received', 'discussion.received', 'mention.received', 'conversation.assigned'])
    carolHook = await hook('carol', carolInbox, ['mention.received', 'conversation.assigned'])
    salesHook = await hook('sales', sales, ['discussion.received', 'conversation.assigned'])
    everyHook = await hook('every', null, ['conversation.assigned'])

    emailThread = await lib.createOutboundThread({
      inboxId: bobInbox,
      subject: 'Chair order',
      subjectNormalised: 'chair order',
      preview: null,
    })
    firstEmail = await inbound(emailThread, 'Chair order', '2026-09-26 09:00:00')
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('tells the owner when post lands in their inbox', async () => {
    expect(await arrival.queueMessageWebhooks(firstEmail)).toBe(1)
    const rows = await queued(bobHook)
    expect(rows.map((r) => r.event)).toEqual(['message.received'])
  })

  it('does not tell them again when that email is handed to them a moment later', async () => {
    // Bob's subscription heard about this email on arrival; the every-inbox one
    // never did, and hears about the hand-over.
    expect(await colleague.queueAssignmentWebhooks({ threadId: emailThread, assigneeUserId: bob, byUserId: chris })).toBe(1)
    expect((await queued(bobHook)).map((r) => r.event)).toEqual(['message.received'])

    const every = await queued(everyHook)
    expect(every.map((r) => r.event)).toEqual(['conversation.assigned'])
    const body = (every[0]!.payload as { body: Record<string, unknown> }).body
    expect(body.event).toBe('conversation.assigned')
    expect((body.message as { from: { address: string } }).from.address).toBe('customer@example.com')
    expect(body.by).toEqual({ id: chris, name: 'chris', email: 'chris@example.com' })
    expect(body.for).toEqual([{
      id: bob, name: 'bob', email: 'bob@example.com', addressed: false, mentioned: false, assigned: true,
    }])
  })

  it('says nothing more for a second hand-over about the same email', async () => {
    expect(await colleague.queueAssignmentWebhooks({ threadId: emailThread, assigneeUserId: bob, byUserId: chris })).toBe(0)
  })

  it('says nothing when somebody takes a conversation themselves', async () => {
    expect(await colleague.queueAssignmentWebhooks({ threadId: emailThread, assigneeUserId: carol, byUserId: carol })).toBe(0)
  })

  it('tells a new owner about a hand-over of post it has never heard about', async () => {
    expect(await colleague.queueAssignmentWebhooks({ threadId: emailThread, assigneeUserId: carol, byUserId: chris })).toBe(1)
    expect((await queued(carolHook)).map((r) => [r.event, r.message_id])).toEqual([['conversation.assigned', firstEmail]])
  })

  it('tells them about a hand-over once newer post has arrived that nobody passed on', async () => {
    const second = await inbound(emailThread, 'Re: Chair order', '2026-09-26 10:00:00')
    // A note is newer still, and must not be what the hand-over is about.
    await lib.insertNote({ threadId: emailThread, channel: 'email', bodyHtml: '<p>fyi</p>', bodyText: 'fyi', authorUserId: chris })
    expect(await colleague.queueAssignmentWebhooks({ threadId: emailThread, assigneeUserId: bob, byUserId: chris })).toBe(2)
    const bobRows = await queued(bobHook)
    expect(bobRows.map((r) => [r.event, r.message_id])).toEqual([
      ['message.received', firstEmail],
      ['conversation.assigned', second],
    ])
  })

  it('tells somebody tagged on an email conversation', async () => {
    const note = await lib.insertNote({
      threadId: emailThread, channel: 'email', bodyHtml: '<p>Carol?</p>', bodyText: 'Carol, can you look?', authorUserId: chris,
    })
    expect(await colleague.queueNoteWebhooks(note, [carol])).toBe(1)
    const rows = await queued(carolHook)
    const last = rows[rows.length - 1]!
    expect(last.event).toBe('mention.received')
    const body = (last.payload as { body: Record<string, unknown> }).body
    expect((body.message as { from: { address: string }; direction: string }).from.address).toBe('chris@example.com')
    expect((body.message as { direction: string }).direction).toBe('note')
  })

  it('tells the people a discussion is put to, and the shared address it is filed in, once each', async () => {
    const thread = await lib.createDiscussionThread({
      inboxId: sales,
      subject: 'Stock check',
      subjectNormalised: 'stock check',
      preview: 'Can you count the chairs',
      startedByUserId: chris,
      toUserIds: [bob],
    })
    await lib.fileThreadInInboxes(thread, [sales, bobInbox])
    const note = await lib.insertNote({
      threadId: thread, channel: 'discussion', bodyHtml: '<p>Count</p>', bodyText: 'Can you count the chairs', authorUserId: chris,
    })
    // Bob is on the To line AND asked - the discussion route does both - and
    // hears it once.
    expect(await colleague.queueNoteWebhooks(note, [bob])).toBe(2)
    expect(await colleague.queueNoteWebhooks(note, [bob])).toBe(0)

    const bobLast = (await queued(bobHook)).at(-1)!
    expect(bobLast.event).toBe('discussion.received')
    const body = (bobLast.payload as { body: Record<string, unknown> }).body
    expect(body.for).toEqual([{
      id: bob, name: 'bob', email: 'bob@example.com', addressed: true, mentioned: true, assigned: false,
    }])
    expect((await queued(salesHook)).map((r) => r.event)).toEqual(['discussion.received'])

    // Bob answers: Chris started it, but has no subscription of his own - so
    // only the shared address hears, and Bob is not told about his own note.
    const reply = await lib.insertNote({
      threadId: thread, channel: 'discussion', bodyHtml: '<p>40</p>', bodyText: 'Forty', authorUserId: bob,
    })
    expect(await colleague.queueNoteWebhooks(reply, [])).toBe(1)
    expect((await queued(bobHook)).at(-1)!.message_id).toBe(note)
  })

  it('holds one message to one delivery per subscription in the database itself', async () => {
    // Whatever the code does, a second event about the same message for the
    // same subscription goes nowhere.
    const inserted = await hooks.enqueueDeliveries([{
      webhookId: bobHook, event: 'mention.received', messageId: firstEmail, threadId: emailThread, payload: {},
    }])
    expect(inserted).toBe(0)
  })
})
