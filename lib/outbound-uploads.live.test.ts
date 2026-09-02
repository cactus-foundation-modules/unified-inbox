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
// Files dropped onto a message, executed.
//
// `migrations/018_outbound_uploads.sql` and the three statements that read and
// write it are raw SQL, and nothing else in this repository runs them: `tsc`
// sees a template string, `eslint` sees a template string, a build never
// executes a query, and the module build gate compiles rather than connects.
//
// The dangerous one is abandonedOutboundUploads. It decides what gets DELETED
// from a customer's storage, and it decides it with two NOT EXISTS clauses, one
// of which casts a jsonb column to text and matches a key inside it. Get that
// wrong in the direction that matches nothing and the sweep bins the file off
// somebody's saved draft. It runs once a night, on a cron, where a wrong answer
// is silent for months.
//
// A real throwaway database on the Postgres VPS, built from the core schema and
// this module's own migrations. Named `cactus_rt_*` and dropped afterwards; the
// live site's database sits on the same server and is never named, opened or
// altered.
//
// Skipped unless opted into, so a plain `npm test` never touches the network:
//
//   RUN_INBOX_UPLOAD_GUARDS=1 npx vitest run \
//     modules/unified-inbox/lib/outbound-uploads.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_UPLOAD_GUARDS === '1'
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

const LONG_AGO = new Date('2020-01-01T00:00:00.000Z')
const CUTOFF = new Date('2020-06-01T00:00:00.000Z')

describe.runIf(shouldRun)('files dropped onto a message, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: Db

  let inboxId = ''
  const emma = 'user-emma'

  /** One dropped file, aged so the sweep will consider it. */
  const drop = async (key: string, aged = true): Promise<string> => {
    const id = await lib.recordOutboundUpload({
      authorUserId: emma,
      mediaKey: key,
      mediaUrl: `https://media.example.com/${key}`,
      mediaProvider: 'B2',
      filename: 'quote.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1234,
    })
    if (aged) {
      await db.$executeRawUnsafe(
        `UPDATE "uin_outbound_uploads" SET "created_at" = $1 WHERE "id" = $2`,
        LONG_AGO, id,
      )
    }
    return id
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
    database = await createTestDatabase(vps, `cactus_rt_uinup_${stamp}`, role)
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

    // A real person: the foreign key to "User" is part of what is being tested.
    await db.$executeRawUnsafe(`INSERT INTO "Role" ("id", "name") VALUES ('role-staff', 'Staff')`)
    await db.$executeRawUnsafe(
      `INSERT INTO "User" ("id", "email", "username", "roleId", "updatedAt")
       VALUES ($1, 'emma@deskwell.co.uk', 'emma', 'role-staff', now())`,
      emma,
    )

    const connection = await lib.createConnection({
      label: 'iCloud',
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapUsername: 'someone@example.com',
      imapPassword: 'nothing-real',
    })
    inboxId = (await lib.createInbox({
      name: 'Purchasing',
      address: 'purchasing@deskwell.co.uk',
      connectionId: connection.id,
    })).id
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('records a drop, and vouches for it to the storage check', async () => {
    await drop('media/unified-inbox/outbound/aaa-quote.pdf', false)
    const refs = await lib.listAttachmentStorageRefs()
    expect(refs).toContain('media/unified-inbox/outbound/aaa-quote.pdf')
    expect(refs).toContain('https://media.example.com/media/unified-inbox/outbound/aaa-quote.pdf')
  })

  it('leaves a fresh drop alone however lost it looks', async () => {
    // Nothing points at it, but somebody may still be writing the message.
    const abandoned = await lib.abandonedOutboundUploads(CUTOFF, 50)
    expect(abandoned.map((row) => row.mediaKey)).not.toContain(
      'media/unified-inbox/outbound/aaa-quote.pdf',
    )
  })

  it('gives up on an old drop nothing points at', async () => {
    const key = 'media/unified-inbox/outbound/bbb-forgotten.pdf'
    await drop(key)
    const abandoned = await lib.abandonedOutboundUploads(CUTOFF, 50)
    expect(abandoned.map((row) => row.mediaKey)).toContain(key)
    const row = abandoned.find((one) => one.mediaKey === key)
    // The shape the sweep deletes with, read back off a real row rather than
    // assumed: a wrong provider or a missing key is a delete that silently
    // never happens.
    expect(row?.mediaProvider).toBe('B2')
    expect(row?.sizeBytes).toBe(1234)
    expect(await lib.deleteOutboundUploads([row!.id])).toBe(1)
    expect((await lib.abandonedOutboundUploads(CUTOFF, 50)).map((r) => r.mediaKey)).not.toContain(key)
  })

  it('keeps an old drop that a draft is still holding', async () => {
    const key = 'media/unified-inbox/outbound/ccc-on-a-draft.pdf'
    await drop(key)
    await lib.saveDraft({
      id: null,
      authorUserId: emma,
      replyableInboxIds: [inboxId],
      inboxId,
      threadId: null,
      mode: 'new',
      to: ['supplier@example.com'],
      cc: [],
      subject: 'The quote you asked for',
      body: 'Attached.',
      attachments: [{
        key,
        url: `https://media.example.com/${key}`,
        filename: 'quote.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1234,
      }],
    })
    // This is the assertion the whole file exists for: the key is inside a
    // jsonb array, and the query has to find it there.
    expect((await lib.abandonedOutboundUploads(CUTOFF, 50)).map((r) => r.mediaKey)).not.toContain(key)
  })

  it('keeps an old drop that was actually sent', async () => {
    const key = 'media/unified-inbox/outbound/ddd-sent.pdf'
    await drop(key)
    const threadId = await lib.createOutboundThread({
      inboxId,
      subject: 'The quote you asked for',
      subjectNormalised: 'the quote you asked for',
      preview: 'Attached.',
    })
    const { row } = await lib.insertOutboundMessage({
      threadId,
      inboxId,
      authorUserId: emma,
      fromName: null,
      fromAddress: 'purchasing@deskwell.co.uk',
      toAddresses: ['supplier@example.com'],
      ccAddresses: [],
      subject: 'The quote you asked for',
      bodyHtml: '<p>Attached.</p>',
      bodyText: 'Attached.',
      snippet: 'Attached.',
      messageIdHeader: '<one@deskwell.co.uk>',
      inReplyTo: null,
      references: [],
      hasAttachments: true,
      sizeBytes: null,
      idempotencyKey: 'one',
    })
    await lib.insertOutboundAttachment({
      messageId: row.id,
      filename: 'quote.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1234,
      mediaKey: key,
      mediaProvider: 'B2',
      mediaUrl: `https://media.example.com/${key}`,
    })
    expect((await lib.abandonedOutboundUploads(CUTOFF, 50)).map((r) => r.mediaKey)).not.toContain(key)
  })

  it('lets go when the person does', async () => {
    await db.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, emma)
    const rows = await db.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS count FROM "uin_outbound_uploads"`,
    )
    expect(Number(rows[0]?.count ?? -1)).toBe(0)
  })
})
