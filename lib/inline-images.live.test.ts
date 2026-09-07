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
// The pictures that came inside the message, executed.
//
// `migrations/048_inline_images.sql` and the three statements around it are raw
// SQL, and nothing else in this repository runs them: `tsc` sees a template
// string, `eslint` sees a template string, and a build never executes a query.
// The column could be missing, the partial index could be malformed, the INSERT
// could name a column that is not there, and every gate on the way to a release
// would still be green - right up until somebody opens their post.
//
// A real throwaway database on the Postgres VPS, built from the core schema and
// this module's own migrations. Named `cactus_rt_*` and dropped afterwards; the
// live site's database sits on the same server and is never named, opened or
// altered.
//
// Skipped unless opted into, so a plain `npm test` never touches the network:
//
//   RUN_INBOX_INLINE_GUARDS=1 npx vitest run \
//     modules/unified-inbox/lib/inline-images.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_INLINE_GUARDS === '1'
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

describe.runIf(shouldRun)('pictures carried inside the message, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: Db

  let inboxId = ''
  let connectionId = ''
  let threadId = ''

  /** One message with the markup given, on the shared thread. */
  const writeMessage = async (bodyHtml: string, uid: number): Promise<string> => {
    const id = await lib.insertMessage({
      threadId,
      connectionId,
      direction: 'in',
      messageIdHeader: `<inline-${uid}@example.com>`,
      inReplyTo: null,
      references: [],
      fromName: 'A Supplier',
      fromAddress: 'sales@supplier.example',
      replyTo: null,
      toAddresses: ['purchasing@deskwell.co.uk'],
      ccAddresses: [],
      subject: 'Quote',
      bodyText: 'Quote attached',
      bodyHtml,
      snippet: 'Quote attached',
      sentAt: new Date(),
      hasAttachments: true,
      sizeBytes: 2048,
      imapFolder: 'INBOX',
      imapUid: uid,
      threadMatch: 'new',
      routedOn: 'to',
      autoKind: null,
    })
    expect(id).not.toBeNull()
    return id!
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
    database = await createTestDatabase(vps, `cactus_rt_uinline_${stamp}`, role)
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
    connectionId = connection.id
    inboxId = (await lib.createInbox({
      name: 'Purchasing',
      address: 'purchasing@deskwell.co.uk',
      connectionId,
    })).id
    threadId = await lib.createThread({
      inboxId,
      subject: 'Quote',
      subjectNormalised: 'quote',
      preview: 'Quote attached',
      lastMessageAt: new Date(),
      lastDirection: 'in',
      unread: true,
    })
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('records the name a part answers to, and hands it back', async () => {
    const messageId = await writeMessage('<p>See below</p><img src="cid:logo@01D9">', 1)
    const attachmentId = await lib.insertAttachment({
      messageId,
      filename: 'logo.png',
      contentType: 'image/png',
      sizeBytes: 4096,
      imapPartId: '0',
      contentId: 'logo@01D9',
    })

    const parts = await lib.inlineImagePartsForMessage(messageId)
    expect(parts).toEqual([
      { id: attachmentId, contentId: 'logo@01D9', filename: 'logo.png', contentType: 'image/png' },
    ])
    // And the column reaches the row every other reader of an attachment uses.
    expect((await lib.getAttachment(attachmentId))?.contentId).toBe('logo@01D9')
  })

  it('points the picture at the part, on the way out of the database', async () => {
    const messageId = await writeMessage(
      '<p>Our quote</p><img src="cid:sig@deskwell" alt="Signature">',
      2,
    )
    const attachmentId = await lib.insertAttachment({
      messageId,
      filename: 'signature.png',
      contentType: 'image/png',
      sizeBytes: 1024,
      imapPartId: '0',
      contentId: '<sig@deskwell>',
    })

    const message = await lib.getMessageHtml(messageId)
    expect(message?.html).toContain(
      `src="/api/m/unified-inbox/messages/${messageId}/inline/${attachmentId}"`,
    )
    expect(message?.html).not.toContain('cid:')
    expect(message?.html).toContain('alt="Signature"')
  })

  it('reads an attachment that arrived before the name was ever recorded', async () => {
    // Every attachment on every live site is in this state until migration 048
    // has been and gone: a row with no content_id, referenced by a name Outlook
    // built out of the filename.
    const messageId = await writeMessage('<img src="cid:image001.png@01DA5C">', 3)
    const attachmentId = await lib.insertAttachment({
      messageId,
      filename: 'image001.png',
      contentType: 'image/png',
      sizeBytes: 900,
      imapPartId: '0',
      contentId: null,
    })

    const message = await lib.getMessageHtml(messageId)
    expect(message?.html).toContain(`/inline/${attachmentId}"`)
  })

  it('leaves a picture nothing answers to with no src at all', async () => {
    const messageId = await writeMessage('<img src="cid:gone@nowhere">', 4)
    await lib.insertAttachment({
      messageId,
      filename: 'invoice.pdf',
      contentType: 'application/pdf',
      sizeBytes: 500,
      imapPartId: '0',
      contentId: 'invoice@x',
    })

    const message = await lib.getMessageHtml(messageId)
    expect(message?.html).not.toMatch(/\ssrc=/)
    expect(message?.html).toContain('data-uin-cid="gone@nowhere"')
  })

  it('leaves a message with no pictures of its own exactly as it was', async () => {
    const messageId = await writeMessage('<p>Nothing attached</p>', 5)
    expect((await lib.getMessageHtml(messageId))?.html).toBe('<p>Nothing attached</p>')
  })

  it('answers who may read a message without dragging its markup along', async () => {
    const messageId = await writeMessage('<p>Access</p>', 6)
    expect(await lib.getMessageAccess(messageId)).toEqual({
      threadId,
      inboxId,
      providerModule: null,
    })
    expect(await lib.getMessageAccess('no-such-message')).toBeNull()
  })
})
