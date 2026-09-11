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
// Filing attachments into the media library, executed.
//
// Every statement this covers is raw SQL, and nothing else in this repository
// runs it: `tsc` sees a template string, `eslint` sees a template string, a
// build never executes a query, and the module build gate compiles rather than
// connects. Two of them are also the sort of SQL that is wrong in a way review
// does not catch - a `DISTINCT ON` deciding who owns a file, and an array
// subscript in a WHERE clause deciding which attachments are offered to a
// backfill.
//
// The migration is the reason this exists at all. `055` decides, once and
// unrepeatably, which historic rows own their bytes; get it wrong and either
// every email attachment on the site is exempt from deletion for ever, or
// throwing away a forward takes the file off the message it was forwarded from.
// So the rows are seeded BEFORE 055 is applied and the column is read after,
// which is the only way to see what it actually did.
//
// A real throwaway database on the Postgres VPS, built from the core schema and
// this module's own migrations. Named `cactus_rt_*` and dropped afterwards; the
// live site's database sits on the same server and is never named, opened or
// altered.
//
// Skipped unless opted into, so a plain `npm test` never touches the network:
//
//   npm run test:inbox-attachment-filing
//
// A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_ATTACHMENT_FILING === '1'
if (shouldRun) {
  try {
    ;(process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile('.env')
  } catch {
    // No .env - the guard below fails the suite loudly rather than skipping.
  }
}

const CORE_SCHEMA = path.join(process.cwd(), 'prisma/migrations/20260626000000_init/migration.sql')
const MODULE_MIGRATIONS = path.join(process.cwd(), 'modules/unified-inbox/migrations')
const FILING_MIGRATION = '055_attachment_library_filing.sql'

const KEY = 'a'.repeat(64)
const PREFIX = 'media/unified-inbox'

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

describe.runIf(shouldRun)('filing attachments, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: Db

  // The original of a forwarded message, the forward itself sharing its bytes,
  // a file picked out of the media library, an inline signature logo, and a
  // plain outbound attachment of its own.
  let originalId = ''
  let forwardId = ''
  let pickedId = ''
  let inlineId = ''
  let sentId = ''
  let inboundMessageId = ''
  let outboundMessageId = ''
  let threadId = ''

  const sharedKey = `${PREFIX}/msg-1/original-invoice.pdf`

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
    database = await createTestDatabase(vps, `cactus_rt_uinfile_${stamp}`, role)
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

    // Everything EXCEPT the one under test, so the rows below exist in the
    // shape 055 will find them in on a real site.
    const files = readdirSync(MODULE_MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
    expect(files).toContain(FILING_MIGRATION)
    for (const file of files.filter((f) => f !== FILING_MIGRATION)) {
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
    const inboxId = (await lib.createInbox({
      name: 'Sales', address: 'hi@deskwell.co.uk', connectionId: connection.id,
    })).id

    const sentAt = new Date('2026-09-02T10:00:00.000Z')
    threadId = await lib.createThread({
      inboxId,
      subject: 'Invoice 4471',
      subjectNormalised: 'invoice 4471',
      preview: 'Attached.',
      lastMessageAt: sentAt,
      lastDirection: 'in',
      unread: true,
    })

    const inbound = await lib.insertMessage({
      threadId,
      connectionId: connection.id,
      direction: 'in',
      messageIdHeader: 'invoice@supplier.co.uk',
      inReplyTo: null,
      references: [],
      fromName: 'Faye',
      fromAddress: 'Faye.Whitmore@Supplier.co.uk',
      replyTo: null,
      toAddresses: ['hi@deskwell.co.uk'],
      ccAddresses: [],
      subject: 'Invoice 4471',
      bodyText: 'Attached.',
      bodyHtml: null,
      snippet: 'Attached.',
      sentAt,
      hasAttachments: true,
      sizeBytes: 2048,
      imapFolder: 'INBOX',
      imapUid: 28,
      threadMatch: 'new',
      routedOn: 'to',
      autoKind: null,
    })
    inboundMessageId = inbound!

    const outbound = await lib.insertOutboundMessage({
      threadId,
      inboxId,
      idempotencyKey: `live-${stamp}`,
      messageIdHeader: 'fwd@deskwell.co.uk',
      inReplyTo: null,
      references: [],
      fromName: 'Deskwell',
      fromAddress: 'hi@deskwell.co.uk',
      toAddresses: ['marcus@deskwell.co.uk', 'someone.else@deskwell.co.uk'],
      ccAddresses: [],
      subject: 'Fwd: Invoice 4471',
      bodyText: 'Passing this on.',
      bodyHtml: '<p>Passing this on.</p>',
      snippet: 'Passing this on.',
      hasAttachments: true,
      sizeBytes: 2048,
      authorUserId: null,
    })
    outboundMessageId = outbound.row.id

    originalId = await lib.insertAttachment({
      messageId: inboundMessageId,
      filename: 'invoice.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
      imapPartId: '2',
      contentId: null,
    })
    inlineId = await lib.insertAttachment({
      messageId: inboundMessageId,
      filename: 'image001.png',
      contentType: 'image/png',
      sizeBytes: 512,
      imapPartId: '3',
      contentId: 'image001.png@01D9',
    })
    // Raw, and not recordAttachmentStored, because that writes media_id - a
    // column 055 has not added yet. This is the shape a real site's rows are in
    // when the migration reaches them, which is the whole point of seeding
    // before applying it.
    const storeBytes = (id: string, key: string) => db.$executeRawUnsafe(
      `UPDATE "uin_attachments"
          SET "media_key" = $1, "media_provider" = 'B2', "media_url" = $2, "fetched_at" = now()
        WHERE "id" = $3`,
      key, `https://media.example.com/${key}`, id,
    )
    await storeBytes(originalId, sharedKey)
    await storeBytes(inlineId, `${PREFIX}/msg-1/logo.png`)

    // The forward: the SAME key as the original, which is what gatherAttachments
    // writes when includeOriginalAttachments is on.
    forwardId = await lib.insertOutboundAttachment({
      messageId: outboundMessageId,
      filename: 'invoice.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
      mediaKey: sharedKey,
      mediaProvider: 'B2',
      mediaUrl: `https://media.example.com/${sharedKey}`,
    })
    // A file picked out of the media library and attached. Not this module's.
    pickedId = await lib.insertOutboundAttachment({
      messageId: outboundMessageId,
      filename: 'chair.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 2048,
      mediaKey: 'media/shop/office-chairs/chair-1.jpg',
      mediaProvider: 'B2',
      mediaUrl: 'https://media.example.com/media/shop/office-chairs/chair-1.jpg',
    })
    // A document dropped onto the message, staged under this module's folder.
    sentId = await lib.insertOutboundAttachment({
      messageId: outboundMessageId,
      filename: 'quote.pdf',
      contentType: 'application/pdf',
      sizeBytes: 4096,
      mediaKey: `${PREFIX}/outbound/upload-1-quote.pdf`,
      mediaProvider: 'B2',
      mediaUrl: `https://media.example.com/${PREFIX}/outbound/upload-1-quote.pdf`,
    })

    // The original arrived before the forward was written. Stated rather than
    // left to two calls to now() landing in the same millisecond, because which
    // of the two owns the file is precisely what is being tested.
    await db.$executeRawUnsafe(
      `UPDATE "uin_attachments" SET "created_at" = $1 WHERE "id" = $2`,
      new Date('2026-09-02T10:00:00.000Z'), originalId,
    )
    await db.$executeRawUnsafe(
      `UPDATE "uin_attachments" SET "created_at" = $1 WHERE "id" = $2`,
      new Date('2026-09-02T11:00:00.000Z'), forwardId,
    )

    // And now the migration under test.
    await applyFile(path.join(MODULE_MIGRATIONS, FILING_MIGRATION))
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  async function ownership(): Promise<Map<string, boolean>> {
    const rows = await db.$queryRawUnsafe<{ id: string; owns_object: boolean }[]>(
      `SELECT "id", "owns_object" FROM "uin_attachments"`,
    )
    return new Map(rows.map((r) => [r.id, r.owns_object]))
  }

  it('gives a shared file to the message it arrived on, not to the forward', async () => {
    const owned = await ownership()
    expect(owned.get(originalId)).toBe(true)
    expect(owned.get(forwardId)).toBe(false)
  })

  it('leaves a file picked out of the media library unowned', async () => {
    // The bug this column exists for: emptying the bin used to delete a product
    // photograph out of storage.
    expect((await ownership()).get(pickedId)).toBe(false)
  })

  it('claims a dropped file and an inline part, both of which this module wrote', async () => {
    const owned = await ownership()
    expect(owned.get(sentId)).toBe(true)
    expect(owned.get(inlineId)).toBe(true)
  })

  it('offers the backfill only what it can actually file', async () => {
    const rows = await lib.unfiledAttachments(50)
    const ids = rows.map((r) => r.id).sort()
    // The original (inbound, has a sender) and the dropped file (outbound, has a
    // recipient). Not the inline logo, not the forward, not the library pick.
    expect(ids).toEqual([originalId, sentId].sort())
    expect(await lib.unfiledAttachmentCount()).toBe(2)
  })

  it('reads the correspondent and the direction off the message', async () => {
    // Verbatim, capitals and all: the column holds what the mail server sent.
    // Folding the case is filingFor's job, deliberately, so that one
    // correspondent is one folder however they spell themselves this week.
    expect(await lib.attachmentFilingContext(originalId)).toMatchObject({
      direction: 'in', fromAddress: 'Faye.Whitmore@Supplier.co.uk', contentId: null,
    })
    const sent = await lib.attachmentFilingContext(sentId)
    expect(sent?.direction).toBe('out')
    // The array subscript is the half of this that a template string hides.
    expect(sent?.toAddresses[0]).toBe('marcus@deskwell.co.uk')
    expect((await lib.attachmentFilingContext(inlineId))?.contentId).toBe('image001.png@01D9')
  })

  it('knows when something else is holding the same bytes', async () => {
    expect(await lib.attachmentKeySharedElsewhere(originalId, sharedKey)).toBe(true)
    expect(await lib.attachmentKeySharedElsewhere(sentId, `${PREFIX}/outbound/upload-1-quote.pdf`)).toBe(false)
  })

  it('tells the forward where the bytes went, without handing over the file', async () => {
    const moved = 'media/inbox/faye.whitmore-supplier.co.uk/received/att-invoice.pdf'
    const movedUrl = `https://media.example.com/${moved}`
    expect(await lib.repointAttachmentsSharingKey(sharedKey, originalId, moved, movedUrl)).toBe(1)

    const forward = await lib.getAttachment(forwardId)
    expect(forward?.mediaKey).toBe(moved)
    expect(forward?.mediaUrl).toBe(movedUrl)
    // Still not its file: one object, one library item, one owner.
    expect(forward?.ownsObject).toBe(false)
    expect(forward?.mediaId).toBeNull()

    // Put it back so the assertions below read the seeded shape.
    expect(await lib.repointAttachmentsSharingKey(moved, originalId, sharedKey, `https://media.example.com/${sharedKey}`)).toBe(1)
  })

  it('records a library row against an attachment and marks it owned', async () => {
    const media = await db.media.create({
      data: {
        key: 'media/inbox/faye.whitmore-supplier.co.uk/received/att-1-invoice.pdf',
        provider: 'B2',
        url: 'https://media.example.com/media/inbox/faye.whitmore-supplier.co.uk/received/att-1-invoice.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
      },
    })
    await lib.recordAttachmentStored(originalId, {
      key: media.key, provider: 'B2', url: media.url, sizeBytes: 1024, mediaId: media.id,
    })

    const stored = await lib.getAttachment(originalId)
    expect(stored?.mediaId).toBe(media.id)
    expect(stored?.ownsObject).toBe(true)

    // Filed, so it is no longer anything the backfill would offer.
    expect(await lib.unfiledAttachmentCount()).toBe(1)

    // And core can see the library row is spoken for, by id as well as by key.
    const refs = await lib.listAttachmentStorageRefs()
    expect(refs).toContain(media.id)
    expect(refs).toContain(media.key)
    expect(refs).toContain(media.url)
  })

  it('hands the delete paths the ownership and the library row', async () => {
    const onMessage = await lib.storedObjectsForMessage(outboundMessageId)
    const picked = onMessage.find((o) => o.attachmentId === pickedId)
    expect(picked?.ownsObject).toBe(false)
    expect(onMessage.find((o) => o.attachmentId === sentId)?.ownsObject).toBe(true)

    const onThread = await lib.storedObjectsForThreads([threadId])
    expect(onThread.find((o) => o.attachmentId === originalId)?.mediaId).toBeTruthy()
  })

  it('tells a dropped file apart from a library pick', async () => {
    // A real row, because uin_outbound_uploads carries a foreign key to it -
    // a dropped file is always somebody's.
    const role = await db.role.create({ data: { name: `staff-${Date.now()}` } })
    const author = await db.user.create({
      data: { email: 'someone@deskwell.co.uk', username: 'someone', roleId: role.id },
    })

    await lib.recordOutboundUpload({
      authorUserId: author.id,
      mediaKey: `${PREFIX}/outbound/upload-1-quote.pdf`,
      mediaUrl: `https://media.example.com/${PREFIX}/outbound/upload-1-quote.pdf`,
      mediaProvider: 'B2',
      filename: 'quote.pdf',
      contentType: 'application/pdf',
      sizeBytes: 4096,
    })
    const staged = await lib.stagedUploadKeys([
      `${PREFIX}/outbound/upload-1-quote.pdf`,
      'media/shop/office-chairs/chair-1.jpg',
    ])
    expect(staged.has(`${PREFIX}/outbound/upload-1-quote.pdf`)).toBe(true)
    expect(staged.has('media/shop/office-chairs/chair-1.jpg')).toBe(false)
    expect((await lib.stagedUploadKeys([])).size).toBe(0)
  })
})
