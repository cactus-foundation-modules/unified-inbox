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
// Clicks, filed against a real database.
//
// Migration 047 does something no other migration in this module does: it drops
// a unique index and puts two PARTIAL ones in its place, and the insert that
// uses them has to name each index's own WHERE clause to be allowed to infer
// it. That is a sentence of raw SQL, and nothing else in this repository would
// ever run it - tsc sees a template string, eslint sees a template string, and
// a build never executes a query. Get the inference wrong and every click
// arrives as `ON CONFLICT` failing outright, in front of a customer, in a route
// that swallows its own errors on purpose.
//
// What is actually being claimed here:
//
//   TWO LINKS IN ONE SECOND ARE TWO CLICKS. Brevo stamps to the second, and the
//   common case for several at once is an office mail scanner working through
//   every address in the message. Under the old key all but one vanished.
//
//   THE SAME LINK TWICE IS ONE CLICK. Brevo redelivers anything it is not
//   thanked for quickly, and a redelivery is not a second visit.
//
//   THE OTHER KINDS STILL DEDUPLICATE. The index they use is now partial, which
//   is exactly the sort of change that quietly stops matching.
//
//   A CLICK IS NOT AN OPEN. It implies delivery and nothing else, because a
//   scanner following a link is not a person reading a quote.
//
// Skipped unless opted into, so a plain `npm test` never touches the network:
//
//   RUN_INBOX_CLICKS=1 npx vitest run \
//     modules/unified-inbox/lib/click-tracking.live.test.ts --testTimeout 120000
//
// A SKIP HERE IS A FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_CLICKS === '1'
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
type Store = typeof import('./campaigns/store')
type Events = typeof import('./campaigns/events')

describe.runIf(shouldRun)('what happens when somebody follows a link', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let inbox: Db
  let store: Store
  let events: Events
  let inboxId: string
  let threadId: string

  /** A sent reply of ours, which is the only thing a delivery event can be
   *  about: the recorder refuses anything that is not ours and outbound. */
  async function sentMessage(): Promise<string> {
    const rows = await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "uin_messages" ("thread_id", "direction", "source", "delivery_status", "subject")
       VALUES ('${threadId}', 'out', 'brevo', 'sent', 'Your quote')
       RETURNING "id"`,
    )
    return rows[0]!.id
  }

  async function messageRow(id: string): Promise<Record<string, unknown>> {
    const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "uin_messages" WHERE "id" = '${id}'`,
    )
    return rows[0]!
  }

  beforeAll(async () => {
    if (!process.env.OVH_SERVER || !process.env.OVH_USER || !process.env.OVH_PASSWORD) {
      throw new Error(
        'OVH_SERVER, OVH_USER and OVH_PASSWORD are needed for this suite. '
        + 'Export them from the Deskwell workspace .env - a skip here is a fail.',
      )
    }
    vps = vpsConfigFromEnv()
    await dropStaleTestObjects(vps)

    const stamp = Date.now()
    role = await createTestRole(vps, `cactus_rt_role_${stamp}`)
    database = await createTestDatabase(vps, `cactus_rt_uinclick_${stamp}`, role)
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

    const inboxRow = await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "uin_inboxes" ("name", "address") VALUES ('Sales', 'sales@example.co.uk') RETURNING "id"`,
    )
    inboxId = inboxRow[0]!.id
    const threadRow = await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "uin_threads" ("inbox_id", "subject") VALUES ('${inboxId}', 'Your quote') RETURNING "id"`,
    )
    threadId = threadRow[0]!.id

    inbox = await import('./db')
    store = await import('./campaigns/store')
    events = await import('./campaigns/events')
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('files two different links from the same second as two clicks', async () => {
    const messageId = await sentMessage()
    const moment = new Date('2026-09-07T10:00:00.000Z')

    const first = await inbox.recordDeliveryEvent(messageId, {
      kind: 'clicked',
      occurredAt: moment,
      detail: 'https://example.co.uk/quote/1',
      bounceKind: null,
      source: 'brevo',
    })
    const second = await inbox.recordDeliveryEvent(messageId, {
      kind: 'clicked',
      occurredAt: moment,
      detail: 'https://example.co.uk/unsubscribe',
      bounceKind: null,
      source: 'brevo',
    })

    expect(first).toBe(true)
    expect(second).toBe(true)

    const row = await messageRow(messageId)
    expect(Number(row.click_count)).toBe(2)
    const listed = await inbox.listDeliveryEvents(messageId)
    expect(listed.filter((e) => e.kind === 'clicked')).toHaveLength(2)
  })

  it('does not count the same link twice when the service sends it again', async () => {
    const messageId = await sentMessage()
    const moment = new Date('2026-09-07T11:00:00.000Z')
    const event = {
      kind: 'clicked' as const,
      occurredAt: moment,
      detail: 'https://example.co.uk/quote/2',
      bounceKind: null,
      source: 'brevo' as const,
    }

    expect(await inbox.recordDeliveryEvent(messageId, event)).toBe(true)
    expect(await inbox.recordDeliveryEvent(messageId, event)).toBe(false)

    const row = await messageRow(messageId)
    expect(Number(row.click_count)).toBe(1)
  })

  it('still deduplicates the kinds that share the other index', async () => {
    const messageId = await sentMessage()
    const moment = new Date('2026-09-07T12:00:00.000Z')
    const open = {
      kind: 'opened' as const,
      occurredAt: moment,
      detail: null,
      bounceKind: null,
      source: 'brevo' as const,
    }

    expect(await inbox.recordDeliveryEvent(messageId, open)).toBe(true)
    expect(await inbox.recordDeliveryEvent(messageId, open)).toBe(false)
    // Delivered at the same moment is a different kind and a different thing
    // that happened, so it is not a duplicate of the open.
    expect(await inbox.recordDeliveryEvent(messageId, {
      ...open, kind: 'delivered',
    })).toBe(true)

    const row = await messageRow(messageId)
    expect(Number(row.open_count)).toBe(1)
  })

  it('takes a click as proof it arrived, and not as proof anybody read it', async () => {
    const messageId = await sentMessage()
    const moment = new Date('2026-09-07T13:00:00.000Z')

    await inbox.recordDeliveryEvent(messageId, {
      kind: 'clicked',
      occurredAt: moment,
      detail: 'https://example.co.uk/quote/3',
      bounceKind: null,
      source: 'brevo',
    })

    const row = await messageRow(messageId)
    expect(row.clicked_at).not.toBeNull()
    expect(row.last_click_at).not.toBeNull()
    expect(row.delivered_at).not.toBeNull()
    // The whole point. A mail scanner following a link is not a person.
    expect(row.opened_at).toBeNull()
    expect(row.open_source).toBeNull()
    expect(Number(row.open_count)).toBe(0)
  })

  it('refuses an event about a message that is not one of ours', async () => {
    expect(await inbox.recordDeliveryEvent('made-up-id', {
      kind: 'clicked',
      occurredAt: new Date(),
      detail: 'https://example.co.uk/nowhere',
      bounceKind: null,
      source: 'brevo',
    })).toBe(false)
  })

  it('marks a campaign send clicked, and delivered with it', async () => {
    const campaignId = await store.createCampaign({
      name: 'September chairs',
      inboxId,
      createdBy: 'tester',
    })
    await store.insertRecipients(
      campaignId,
      [{
        personId: null,
        address: 'buyer@example.co.uk',
        firstName: null,
        lastName: null,
        displayName: null,
        organisationName: null,
      }],
      new Date(),
    )
    const { rows } = await store.listRecipients(campaignId, {
      state: null, search: null, page: 1, perPage: 50,
    })
    const recipient = rows[0]!
    const sendId = await store.startSend({
      campaignId,
      recipientId: recipient.id,
      stepIndex: 0,
      address: recipient.address,
      messageId: 'campaign-one@example.co.uk',
    })
    await store.settleSend(sendId!, { ok: true, sentAt: new Date(), providerMessageId: null })

    const filed = await events.applyCampaignEvent(sendId!, {
      kind: 'clicked',
      occurredAt: new Date('2026-09-07T14:00:00.000Z'),
      detail: 'https://example.co.uk/chairs',
    })
    expect(filed).toBe(true)

    const send = await db.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "uin_campaign_sends" WHERE "id" = '${sendId}'`,
    )
    expect(send[0]!.clicked_at).not.toBeNull()
    // Nothing gets followed out of a message that never landed.
    expect(send[0]!.delivered_at).not.toBeNull()
    expect(send[0]!.opened_at).toBeNull()
  })
})
