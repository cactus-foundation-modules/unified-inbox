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

// ---------------------------------------------------------------------------
// The site's own email tracking, executed (core reconcile 043, module 061).
//
// Every write here is raw SQL or a Prisma call against tables no typecheck ever
// runs: core's EmailEvent insert, the bounce matching on two Message-ID
// spellings, the grouped summary, the listener's lookup by ref and by log row,
// and the ledger filing with source = 'site'. So a real throwaway `cactus_rt_*`
// database on the Postgres VPS, dropped afterwards; the live site's database on
// the same server is never named, opened or altered. From the core checkout,
// with OVH_SERVER/OVH_USER/OVH_PASSWORD exported from the Deskwell workspace .env:
//
//   RUN_EMAIL_TRACKING=1 npx vitest run \
//     modules/unified-inbox/lib/own-tracking.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_EMAIL_TRACKING === '1'
if (shouldRun) {
  try {
    ;(process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile('.env')
  } catch {
    // No .env - the guard below fails the suite loudly rather than skipping.
  }
}

const CORE_SCHEMA = path.join(process.cwd(), 'prisma/migrations/20260626000000_init/migration.sql')
const RECONCILE_043 = path.join(process.cwd(), 'prisma/core-reconcile/043_email_tracking.sql')
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

describe.runIf(shouldRun)('the site\'s own email tracking against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: typeof import('./db')
  let events: typeof import('@/lib/email/tracking/events')
  let inbox: string
  let reply: string
  let filedCopy: string
  const replyLog = 'logreply0000000000000000000000001'
  const copyLog = 'logcopy00000000000000000000000001'

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
    database = await createTestDatabase(vps, `cactus_rt_uintrack_${stamp}`, role)
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
    events = await import('@/lib/email/tracking/events')

    // Installed, with the listener in its manifest, exactly as a live site has
    // it - so the chain from core's insert to this module's ledger is the real
    // one, not a direct call.
    await db.$executeRawUnsafe(
      `INSERT INTO "Module" ("id", "name", "repoUrl", "version", "tablePrefix", "status", "manifest")
       VALUES ('mod-uin', 'unified-inbox', 'https://example.invalid', '0.1.96', 'uin_', 'active', $1::jsonb)`,
      JSON.stringify({ extensionPoints: [{ point: 'core.email-tracking-event', id: 'unified-inbox' }] }),
    )

    const rows = await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "uin_inboxes" ("name", "address", "send_transport") VALUES ('Outreach', 'outreach@example.com', 'smtp') RETURNING "id"`,
    )
    inbox = rows[0]!.id

    const outbound = async (key: string, header: string) => {
      const thread = await lib.createOutboundThread({ inboxId: inbox, subject: 'Your quote', subjectNormalised: 'your quote', preview: null })
      const { row } = await lib.insertOutboundMessage({
        threadId: thread,
        inboxId: inbox,
        idempotencyKey: key,
        messageIdHeader: header,
        inReplyTo: null,
        references: [],
        fromName: 'Deskwell',
        fromAddress: 'outreach@example.com',
        toAddresses: ['jane@customer.example'],
        ccAddresses: [],
        subject: 'Your quote',
        bodyText: 'Here it is',
        bodyHtml: '<p>Here it is</p>',
        snippet: 'Here it is',
        hasAttachments: false,
        sizeBytes: 20,
        authorUserId: null,
      })
      return row.id
    }
    reply = await outbound('k-reply', 'uin-reply@example.com')
    filedCopy = await outbound('k-copy', 'po-copy@example.com')

    for (const [id, messageId, providerId] of [
      [replyLog, '<uin-reply@example.com>', '<uin-reply@example.com>'],
      [copyLog, null, '<po-copy@example.com>'],
    ] as const) {
      await db.$executeRawUnsafe(
        `INSERT INTO "EmailLog" ("id", "toAddress", "ccAddresses", "subject", "status", "messageId", "providerId", "transport", "tracked", "moduleName")
         VALUES ($1, 'jane@customer.example', ARRAY[]::text[], 'Your quote', 'sent', $2, $3, 'smtp', true, $4)`,
        id, messageId, providerId, id === replyLog ? 'unified-inbox' : 'purchase-orders',
      )
    }
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  // The reconcile file is run the way scripts/reconcile-core-schema.mjs runs it:
  // the whole file in one query through node-postgres, which is what lets its
  // DO block through. Prisma's one-statement-at-a-time path is not how it ever
  // reaches a database.
  async function withPg<T>(work: (client: import('pg').Client) => Promise<T>): Promise<T> {
    const { Client } = await import('pg')
    // Encrypted but not hostname-checked, which is what Prisma's
    // sslmode=require already does on the same connection: the test role
    // connects by the server's own name, the certificate carries the site's.
    const uri = new URL(database.connectionUri)
    uri.searchParams.set('sslmode', 'no-verify')
    const client = new Client({ connectionString: uri.toString() })
    await client.connect()
    try {
      return await work(client)
    } finally {
      await client.end().catch(() => {})
    }
  }

  it('reconcile 043 runs twice over a fresh install without complaint', async () => {
    const sql = readFileSync(RECONCILE_043, 'utf8')
    await withPg(async (client) => {
      await client.query(sql)
      await client.query(sql)
    })
  })

  it('reconcile 043 brings an older install up to date', async () => {
    // A cut-down pre-043 install in a schema of its own, inside a transaction
    // that is rolled back, so nothing it does outlives the test.
    const sql = readFileSync(RECONCILE_043, 'utf8')
    const names = await withPg(async (client) => {
      await client.query('BEGIN')
      try {
        await client.query(`CREATE SCHEMA "old_install"`)
        await client.query(`SET LOCAL search_path TO "old_install"`)
        await client.query(`CREATE TABLE "SiteConfig" ("id" TEXT PRIMARY KEY)`)
        await client.query(`CREATE TABLE "EmailLog" ("id" TEXT PRIMARY KEY, "providerId" TEXT)`)
        await client.query(sql)
        const { rows } = await client.query<{ table_name: string; column_name: string }>(
          `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'old_install' ORDER BY 1, 2`,
        )
        return rows.map((c) => `${c.table_name}.${c.column_name}`)
      } finally {
        await client.query('ROLLBACK')
      }
    })
    expect(names).toEqual(expect.arrayContaining([
      'SiteConfig.emailTracking', 'EmailLog.transport', 'EmailLog.tracked', 'EmailEvent.emailLogId', 'EmailEvent.occurredAt',
    ]))
  })

  it('switches tracking on for a new inbox, and off when told', async () => {
    expect((await lib.getInbox(inbox))?.ownTracking).toBe(true)
    expect((await lib.updateInbox(inbox, { ownTracking: false }))?.ownTracking).toBe(false)
    expect((await lib.updateInbox(inbox, { ownTracking: true }))?.ownTracking).toBe(true)
  })

  it('keeps what core said about the send on the message', async () => {
    for (const [id, log] of [[reply, replyLog], [filedCopy, copyLog]] as const) {
      await lib.settleDelivery(id, { status: 'sent', providerMessageId: null, tracking: { emailLogId: log, sentVia: 'smtp', tracked: true } })
    }
    expect(await lib.getSentMessageForHistory(reply)).toMatchObject({ sentVia: 'smtp', siteTracked: true })
  })

  it('files an open from our own picture on the reply, by its ref', async () => {
    const at = new Date('2026-09-26T10:00:00.000Z')
    const filed = await events.recordObservedEvent(
      { k: 'o', e: replyLog, m: 'unified-inbox', x: reply },
      { kind: 'opened', occurredAt: at, ip: '81.2.69.160', userAgent: 'Outlook' },
    )
    expect(filed).toBe(true)

    const ledger = await lib.listDeliveryEvents(reply)
    expect(ledger).toEqual([expect.objectContaining({ kind: 'opened', source: 'site', ip: '81.2.69.160', userAgent: 'Outlook' })])
    const message = (await lib.listThreadMessages((await lib.getSentMessageForHistory(reply))!.threadId)).find((m) => m.id === reply)!
    expect(message).toMatchObject({ openCount: 1, openSource: 'human', sentVia: 'smtp', siteTracked: true })
  })

  it('files a click on a copy of module mail by its log row alone', async () => {
    const at = new Date('2026-09-26T10:05:00.000Z')
    await events.recordObservedEvent(
      { k: 'c', e: copyLog, m: 'purchase-orders', u: 'https://example.com/po/7' },
      { kind: 'clicked', occurredAt: at, ip: null, userAgent: 'Safari' },
    )
    const ledger = await lib.listDeliveryEvents(filedCopy)
    expect(ledger).toEqual([expect.objectContaining({ kind: 'clicked', source: 'site', detail: 'https://example.com/po/7' })])
  })

  it('never lets another module\'s ref land on one of our messages', async () => {
    await events.recordObservedEvent(
      { k: 'o', e: copyLog, m: 'purchase-orders', x: reply },
      { kind: 'proxy_open', occurredAt: new Date('2026-09-26T10:06:00.000Z'), ip: null, userAgent: 'Mozilla/5.0' },
    )
    // Filed on the copy (its own log row), not on the reply the stray ref named.
    expect((await lib.listDeliveryEvents(reply)).map((e) => e.kind)).toEqual(['opened'])
    expect((await lib.listDeliveryEvents(filedCopy)).map((e) => e.kind).sort()).toEqual(['clicked', 'proxy_open'])
  })

  it('shrugs at an event for a send that no longer exists', async () => {
    expect(await events.recordObservedEvent(
      { k: 'o', e: 'gone-to-the-retention-sweep' },
      { kind: 'opened', occurredAt: new Date(), ip: null, userAgent: null },
    )).toBe(false)
  })

  it('matches a bounce by either spelling of the Message-ID, once', async () => {
    const at = new Date('2026-09-26T11:00:00.000Z')
    const report = { messageIds: ['uin-reply@example.com', 'po-copy@example.com'], kind: 'hard' as const, detail: 'That address does not exist at their end.', occurredAt: at }
    expect((await events.recordEmailBounce(report)).sort()).toEqual([copyLog, replyLog].sort())
    // The same report read again - a mailbox checked twice - changes nothing.
    expect(await events.recordEmailBounce(report)).toEqual([])

    const message = (await lib.listThreadMessages((await lib.getSentMessageForHistory(reply))!.threadId)).find((m) => m.id === reply)!
    expect(message).toMatchObject({ bounceKind: 'hard', bounceDetail: 'That address does not exist at their end.' })
    expect((await lib.listDeliveryEvents(reply)).filter((e) => e.kind === 'bounced')).toHaveLength(1)
  })

  it('sums it all up for the person timeline', async () => {
    const summary = await events.emailEngagementFor([replyLog, copyLog, 'nothing-here'])
    expect(summary.get(replyLog)).toMatchObject({ openCount: 1, clickCount: 0, bounceDetail: 'That address does not exist at their end.' })
    expect(summary.get(copyLog)).toMatchObject({ clickCount: 1, openCount: 0 })
    expect(summary.get(copyLog)?.proxyOpenAt).toBeInstanceOf(Date)
    expect(summary.has('nothing-here')).toBe(false)

    const rows = await lib.outboundLogForAddresses(['JANE@customer.example'])
    expect(rows.find((r) => r.id === replyLog)).toMatchObject({ transport: 'smtp', tracked: true, engagement: expect.objectContaining({ openCount: 1 }) })
  })

  it('goes with its log row when the retention sweep takes it', async () => {
    await db.$executeRawUnsafe(`DELETE FROM "EmailLog" WHERE "id" = $1`, copyLog)
    const left = await db.$queryRawUnsafe<{ count: bigint }[]>(`SELECT COUNT(*)::bigint AS count FROM "EmailEvent" WHERE "emailLogId" = $1`, copyLog)
    expect(Number(left[0]!.count)).toBe(0)
  })
})
