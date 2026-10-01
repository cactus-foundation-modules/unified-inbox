import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { PrismaClient } from '@prisma/client'
import type { ExtendedPrismaClient } from '@/lib/db/prisma'
import type { ConversationMessage, ResolvedConversationProvider } from '@/lib/conversations/types'
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
import type { InboundMessageEvent } from './types'

// ---------------------------------------------------------------------------
// `unified-inbox.message-received`, executed.
//
// Everything in lib/message-handlers-db.ts is raw SQL - strings to `tsc`, to
// `eslint` and to a build - so it is run here against a real database: which
// messages are offerable at all, the catch-up's window, the button's paging,
// the handled_at stamp and the notes, and a message arriving on a channel
// being offered to a listener on its way in. Migration 070 is applied twice,
// because a module's migrations run again on an install whose build failed
// part-way: idempotent or broken.
//
// A real throwaway database on the Postgres VPS, built from the core schema and
// this module's own migrations. Named `cactus_rt_*` and dropped afterwards; the
// live site's database sits on the same server and is never named, opened or
// altered. Every address and name below is invented.
//
//   RUN_INBOX_MESSAGE_HANDLERS=1 npx vitest run \
//     modules/unified-inbox/lib/message-handlers.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_MESSAGE_HANDLERS === '1'

const CORE_SCHEMA = path.join(process.cwd(), 'prisma/migrations/20260626000000_init/migration.sql')
const MODULE_MIGRATIONS = path.join(process.cwd(), 'modules/unified-inbox/migrations')
const KEY = 'a'.repeat(64)
const POINT = 'unified-inbox.message-received'

// The listener the channel test registers. Everything else passes its handlers
// in by hand, so this registry is only read by the provider-sync path.
const heard = vi.hoisted(() => ({ events: [] as InboundMessageEvent[] }))
vi.mock('@/lib/modules/extension-points.server', () => ({
  moduleServerExtensionPointComponents: {
    'unified-inbox.message-received': {
      'test-listener': async (event: InboundMessageEvent) => {
        heard.events.push(event)
        return { note: 'Heard by the test listener' }
      },
    },
  },
}))
vi.mock('@/lib/modules/live-status', () => ({
  getInstalledManifests: async () => [{
    manifest: {
      name: 'test-module',
      extensionPoints: [{ point: 'unified-inbox.message-received', id: 'test-listener' }],
    },
  }],
}))

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

const HOUR = 3_600_000
const DAY = 24 * HOUR

describe.runIf(shouldRun)('offering inbound mail to other modules, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: typeof import('./db')
  let store: typeof import('./message-handlers-db')
  let handlers: typeof import('./message-handlers')

  let inboxId = ''
  let otherInboxId = ''
  let thread = ''
  const ids: Record<string, string> = {}

  /** One message, dated and filed as the test says. */
  async function message(name: string, data: {
    threadId?: string
    direction?: 'in' | 'out' | 'note'
    autoKind?: string | null
    sentAgo: number
    createdAgo?: number
    subject?: string
  }): Promise<string> {
    // Dated off the database's own clock, not this machine's: every window
    // being tested is measured with the database's now(), and the two clocks
    // need not agree.
    const sentSecs = data.sentAgo / 1000
    const createdSecs = (data.createdAgo ?? data.sentAgo) / 1000
    const rows = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO "uin_messages"
        ("thread_id", "direction", "from_address", "to_addresses", "subject", "body_text",
         "sent_at", "created_at", "auto_kind", "source")
      VALUES (${data.threadId ?? thread}, ${data.direction ?? 'in'}, 'Accounts@Supplier.example',
              ARRAY['purchasing@shop.example']::text[], ${data.subject ?? name},
              ${`Body of ${name}`},
              now() - make_interval(secs => ${sentSecs}::float8),
              now() - make_interval(secs => ${createdSecs}::float8),
              ${data.autoKind ?? null}, 'imap')
      RETURNING "id"
    `
    ids[name] = rows[0]!.id
    return rows[0]!.id
  }

  async function newThread(subject: string, inbox = inboxId): Promise<string> {
    return lib.createThread({
      inboxId: inbox,
      subject,
      subjectNormalised: subject.toLowerCase(),
      preview: null,
      lastMessageAt: new Date(),
      lastDirection: 'in',
      unread: true,
    })
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
    database = await createTestDatabase(vps, `cactus_rt_uinmh_${stamp}`, role)
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
    await applyFile(path.join(MODULE_MIGRATIONS, '070_message_handlers.sql'))

    lib = await import('./db')
    store = await import('./message-handlers-db')
    handlers = await import('./message-handlers')

    const connection = await lib.createConnection({
      label: 'Office mail',
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapUsername: 'purchasing@shop.example',
      imapPassword: 'nothing-real',
    })
    inboxId = (await lib.createInbox({
      name: 'Purchasing', address: 'purchasing@shop.example', connectionId: connection.id,
    })).id
    otherInboxId = (await lib.createInbox({
      name: 'Sales', address: 'sales@shop.example', connectionId: connection.id,
    })).id

    await db.$executeRawUnsafe(`INSERT INTO "Role" ("id", "name") VALUES ('role-staff', 'Staff')`)
    await db.$executeRawUnsafe(
      `INSERT INTO "User" ("id", "email", "username", "roleId", "updatedAt")
       VALUES ('user-sam', 'sam@shop.example', 'sam', 'role-staff', now())`,
    )

    thread = await newThread('Your order')
    const blocked = await newThread('Blocked')
    await lib.setThreadBlocked(blocked, true)
    const junk = await newThread('Junk')
    await db.$executeRaw`INSERT INTO "uin_thread_spam" ("thread_id", "user_id") VALUES (${junk}, 'user-sam')`
    const sales = await newThread('Sales enquiry', otherInboxId)

    await message('fresh', { sentAgo: HOUR })
    await message('outbound', { sentAgo: HOUR, direction: 'out' })
    await message('note', { sentAgo: HOUR, direction: 'note' })
    await message('bounce', { sentAgo: HOUR, autoKind: 'bounce' })
    await message('blocked', { threadId: blocked, sentAgo: HOUR })
    await message('junk', { threadId: junk, sentAgo: HOUR })
    // Collected an hour ago, written a year ago: history a new mailbox was read
    // in with, which is not news.
    await message('history', { sentAgo: 365 * DAY, createdAgo: HOUR })
    // Collected and written a week ago: outside the catch-up, inside the button.
    await message('lastWeek', { sentAgo: 7 * DAY })
    // A month ago: outside both.
    await message('lastMonth', { sentAgo: 30 * DAY })
    await message('sales', { threadId: sales, sentAgo: 2 * HOUR })

    await db.$executeRaw`
      INSERT INTO "uin_attachments"
        ("message_id", "filename", "content_type", "size_bytes", "imap_part_id", "content_id", "media_id")
      VALUES (${ids.fresh}, 'proforma.pdf', 'application/pdf', 1234, '0', NULL, 'media-proforma'),
             (${ids.fresh}, 'image001.png', 'image/png', 99, '1', 'logo@example', 'media-logo'),
             (${ids.fresh}, 'terms.pdf', NULL, NULL, '2', NULL, NULL)
    `
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('shapes an offerable message as the point promises', async () => {
    await db.$executeRaw`
      UPDATE "uin_messages" SET "cc_addresses" = ARRAY['orders@shop.example', 'sam@shop.example']::text[]
       WHERE "id" = ${ids.fresh}
    `
    const offerable = await store.loadOfferableMessage(ids.fresh!)
    expect(offerable).not.toBeNull()
    const { event } = offerable!
    expect(event).toMatchObject({
      messageId: ids.fresh,
      threadId: thread,
      fromAddress: 'accounts@supplier.example',
      toAddresses: ['purchasing@shop.example'],
      ccAddresses: ['orders@shop.example', 'sam@shop.example'],
      subject: 'fresh',
      bodyText: 'Body of fresh',
    })
    expect(new Date(event.sentAt).toISOString()).toBe(event.sentAt)
    // One INSERT wrote all three, so they share a created_at and the order
    // between them is the ids'. Compared by name.
    const byName = [...event.attachments].sort((a, b) => a.filename.localeCompare(b.filename))
    expect(byName).toEqual([
      // An inline part has a library row of its own and is still handed over
      // with none: listeners ignore it.
      expect.objectContaining({ filename: 'image001.png', mediaId: null }),
      expect.objectContaining({ filename: 'proforma.pdf', mimeType: 'application/pdf', sizeBytes: 1234, mediaId: 'media-proforma' }),
      expect.objectContaining({ filename: 'terms.pdf', mimeType: 'application/octet-stream', sizeBytes: 0, mediaId: null }),
    ])
    expect(offerable!.handledAt).toBeNull()
    expect(offerable!.notes).toEqual([])
  })

  it('never offers our own writing, the mail system, a blocked sender or a junked conversation', async () => {
    for (const name of ['outbound', 'note', 'bounce', 'blocked', 'junk']) {
      expect(await store.loadOfferableMessage(ids[name]!), name).toBeNull()
    }
  })

  it('caps the body the way the reference scan does', async () => {
    await db.$executeRaw`UPDATE "uin_messages" SET "body_text" = ${'x'.repeat(30_000)} WHERE "id" = ${ids.sales}`
    const offerable = await store.loadOfferableMessage(ids.sales!)
    expect(offerable!.event.bodyText.length).toBe(20_000)
    // Nobody copied in: an empty list, never null.
    expect(offerable!.event.ccAddresses).toEqual([])
  })

  it('lists files still on the mail server, and not inline parts', async () => {
    const terms = await db.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "uin_attachments" WHERE "filename" = 'terms.pdf'
    `
    expect(await store.unstoredAttachments(ids.fresh!)).toEqual([
      { id: terms[0]!.id, contentType: null, sizeBytes: null },
    ])
    // Stored from here on, so nothing below goes looking for a mail server.
    await db.$executeRaw`UPDATE "uin_attachments" SET "media_id" = 'media-terms' WHERE "id" = ${terms[0]!.id}`
    expect(await store.unstoredAttachments(ids.fresh!)).toEqual([])
    // What is already stored counts against the message's allowance: the PDF
    // and the stored copy of terms, not the inline logo.
    expect(await store.storedAttachmentBytes(ids.fresh!)).toBe(1234)
  })

  it('the catch-up finds recent post never offered, and nothing else', async () => {
    const found = await store.unofferedMessageIds(50)
    expect(new Set(found)).toEqual(new Set([ids.fresh, ids.sales]))
  })

  it('stamps a message offered, keeps the notes, and the catch-up stops seeing it', async () => {
    const outcome = await handlers.offerMessage(ids.fresh!, {
      handlers: [
        {
          moduleName: 'test-module', id: 'broken', source: 'test-module:broken', attachmentTypes: [],
          handle: async () => { throw new Error('a listener having a bad day') },
        },
        {
          moduleName: 'test-module', id: 'filing', source: 'test-module:filing', attachmentTypes: [],
          handle: async () => ({
            links: [{ moduleName: 'test-module', recordType: 'thing', recordId: 'thing-1', label: 'Thing 1' }],
            note: 'Filed on Thing 1',
          }),
        },
      ],
    })
    expect(outcome).toBe('offered')

    const row = (await db.$queryRaw<{ handled_at: Date | null; handler_notes: unknown }[]>`
      SELECT "handled_at", "handler_notes" FROM "uin_messages" WHERE "id" = ${ids.fresh}
    `)[0]!
    expect(row.handled_at).toBeInstanceOf(Date)
    expect(row.handler_notes).toEqual([
      expect.objectContaining({ source: 'test-module:filing', moduleName: 'test-module', note: 'Filed on Thing 1' }),
    ])

    const linked = await lib.linksForThread(thread)
    expect(linked).toEqual([expect.objectContaining({
      moduleName: 'test-module', recordType: 'thing', recordId: 'thing-1', label: 'Thing 1', linkedBy: 'auto',
    })])

    expect(await store.unofferedMessageIds(50)).toEqual([ids.sales])

    // The conversation view reads the note straight off the row.
    const onScreen = (await lib.listThreadMessages(thread)).find((m) => m.id === ids.fresh)!
    expect(onScreen.handlerNotes.map((n) => n.note)).toEqual(['Filed on Thing 1'])
  })

  it('a second offer is harmless: one link, one line, replaced not added', async () => {
    const outcome = await handlers.offerMessage(ids.fresh!, {
      force: true,
      handlers: [{
        moduleName: 'test-module', id: 'filing', source: 'test-module:filing', attachmentTypes: [],
        handle: async () => ({
          links: [{ moduleName: 'test-module', recordType: 'thing', recordId: 'thing-1', label: 'Thing 1' }],
          note: 'Filed on Thing 1, again',
        }),
      }],
    })
    expect(outcome).toBe('offered')
    expect((await lib.linksForThread(thread)).length).toBe(1)
    const notes = (await store.loadOfferableMessage(ids.fresh!))!.notes
    expect(notes.map((n) => n.note)).toEqual(['Filed on Thing 1, again'])
  })

  it('a stamp-free write keeps the notes and leaves the message for the catch-up', async () => {
    await store.recordOffer(ids.sales!, {
      notes: [{ source: 's:1', moduleName: 's', note: 'Half done', at: new Date().toISOString() }],
      stamp: false,
    })
    const again = await store.loadOfferableMessage(ids.sales!)
    expect(again!.handledAt).toBeNull()
    expect(again!.notes.map((n) => n.note)).toEqual(['Half done'])
    expect(await store.unofferedMessageIds(50)).toEqual([ids.sales])
  })

  it('lets exactly one of two racing callers claim a message, and nobody take over a live claim', async () => {
    const [a, b] = await Promise.all([store.claimOffer(ids.sales!, false), store.claimOffer(ids.sales!, false)])
    expect([a, b].filter(Boolean).length).toBe(1)
    // The button's force does not take it from under a run in progress either.
    expect(await store.claimOffer(ids.sales!, true)).toBe(false)
    // And while it is held, the catch-up does not see it.
    expect(await store.unofferedMessageIds(50)).toEqual([])
    // A claim left by a run that died is taken over once it is stale.
    await db.$executeRaw`UPDATE "uin_messages" SET "offering_at" = now() - interval '3 minutes' WHERE "id" = ${ids.sales}`
    expect(await store.claimOffer(ids.sales!, false)).toBe(true)
    await store.releaseClaim(ids.sales!)
    const attempts = (await db.$queryRaw<{ offer_attempts: number }[]>`
      SELECT "offer_attempts" FROM "uin_messages" WHERE "id" = ${ids.sales}
    `)[0]!.offer_attempts
    expect(attempts).toBe(2)

    // A claim handed back only because the clock ran out refunds its attempt.
    expect(await store.claimOffer(ids.sales!, false)).toBe(true)
    await store.releaseClaim(ids.sales!, { refund: true })
    const after = (await db.$queryRaw<{ offer_attempts: number; offering_at: Date | null }[]>`
      SELECT "offer_attempts", "offering_at" FROM "uin_messages" WHERE "id" = ${ids.sales}
    `)[0]!
    expect(after).toEqual({ offer_attempts: 2, offering_at: null })
  })

  it('never claims a message already offered, except for the button', async () => {
    expect(await store.claimOffer(ids.fresh!, false)).toBe(false)
    expect(await store.claimOffer(ids.fresh!, true)).toBe(true)
    await store.releaseClaim(ids.fresh!)
  })

  it('leaves the last few minutes to the collecting pass, and puts the most-tried last', async () => {
    // Both removed whatever happens: a row left behind by a failed assertion
    // here would sit unoffered in the settling window and fail the catch-up
    // tests below for a reason that has nothing to do with them.
    const justNow = await message('justNow', { sentAgo: 60_000 })
    try {
      expect(await store.unofferedMessageIds(50)).not.toContain(justNow)
    } finally {
      await db.$executeRaw`DELETE FROM "uin_messages" WHERE "id" = ${justNow}`
    }

    const another = await message('another', { threadId: thread, sentAgo: 3 * HOUR })
    try {
      // 'another' is older than 'sales' but tried more often, so it goes second.
      await db.$executeRaw`UPDATE "uin_messages" SET "offer_attempts" = 5 WHERE "id" = ${another}`
      expect(await store.unofferedMessageIds(50)).toEqual([ids.sales, another])
    } finally {
      await db.$executeRaw`DELETE FROM "uin_messages" WHERE "id" = ${another}`
    }
  })

  it('keeps an automatic link somebody took off from coming back', async () => {
    const link = { threadId: thread, moduleName: 'test-module', recordType: 'thing', recordId: 'thing-2', label: 'Thing 2', confidence: 90 }
    expect(await store.recordHandlerLink(link)).toBe(true)
    const made = (await lib.linksForThread(thread)).find((l) => l.recordId === 'thing-2')!
    await lib.deleteLink(made.id)
    await store.rememberRemovedAutoLink({ ...link, removedBy: 'user-sam' })
    // Twice, as a second click would.
    await store.rememberRemovedAutoLink({ ...link, removedBy: 'user-sam' })
    expect(await store.recordHandlerLink(link)).toBe(false)
    expect((await lib.linksForThread(thread)).some((l) => l.recordId === 'thing-2')).toBe(false)

    // Putting it back by hand is somebody changing their mind, and clears it.
    await lib.recordLink({ ...link, personId: null, linkedBy: 'user' })
    const removals = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "uin_record_link_removals" WHERE "record_id" = 'thing-2'
    `
    expect(Number(removals[0]!.n)).toBe(0)
    await db.$executeRaw`DELETE FROM "uin_record_links" WHERE "record_id" = 'thing-2'`
  })

  it('the button pages through one inbox’s fortnight, offered or not', async () => {
    // A page at a time, as the button asks for them.
    const walked: string[] = []
    let after: string | null = null
    for (let page = 0; page < 10; page++) {
      const got: string[] = await store.inboxMessageIdsToReoffer(inboxId, after, 1)
      if (got.length === 0) break
      walked.push(...got)
      after = got[0]!
    }
    // Oldest collected first: last week's, then today's. The history filed an
    // hour ago is left out by its date. Nothing from the other inbox, the
    // month-old message, or anything that is never offerable.
    expect(walked).toEqual([ids.lastWeek, ids.fresh])
    expect(await store.inboxMessageIdsToReoffer(otherInboxId, null, 10)).toEqual([ids.sales])
  })

  it('offers a message arriving on a channel to the listener as it is filed', async () => {
    const said: ConversationMessage[] = [
      {
        id: 'enquiry:1', direction: 'in', authorName: 'A Customer', text: 'Do you deliver on Saturdays?',
        html: null, sentAt: new Date(Date.now() - 60_000), attachments: [],
      } as ConversationMessage,
      {
        id: 'enquiry:2', direction: 'out', authorName: 'Us', text: 'We do.',
        html: null, sentAt: new Date(Date.now() - 30_000), attachments: [],
      } as ConversationMessage,
    ]
    const summary = {
      id: 'conv-1',
      channel: 'form' as const,
      subject: 'Website enquiry',
      preview: null,
      participant: { name: 'A Customer', email: 'customer@example.com', phone: null },
      lastMessageAt: new Date(),
      unread: true,
      status: 'open' as const,
      href: 'm/enquiries',
    }
    const channel = {
      moduleName: 'enquiry-module',
      id: 'enquiry-module',
      provider: {
        label: 'Enquiries',
        channel: 'form',
        capabilities: { reply: false, markRead: false, byIdentity: false },
        list: async () => ({ items: [summary] }),
        thread: async () => ({ summary, messages: said }),
      },
    } as unknown as ResolvedConversationProvider

    const sync = await import('./provider-sync')
    heard.events.length = 0
    await sync.syncProvider(channel)

    // Their message and not ours.
    expect(heard.events.map((e) => e.bodyText)).toEqual(['Do you deliver on Saturdays?'])
    expect(heard.events[0]!.fromAddress).toBe('customer@example.com')
    expect(heard.events[0]!.ccAddresses).toEqual([])
    const row = (await db.$queryRaw<{ handled_at: Date | null; handler_notes: unknown }[]>`
      SELECT "handled_at", "handler_notes" FROM "uin_messages" WHERE "id" = ${heard.events[0]!.messageId}
    `)[0]!
    expect(row.handled_at).toBeInstanceOf(Date)
    expect(row.handler_notes).toEqual([expect.objectContaining({ note: 'Heard by the test listener' })])

    // Collected again: nothing new, nobody told twice.
    await sync.syncProvider(channel)
    expect(heard.events.length).toBe(1)
  })

  it('the catch-up offers what is left, and then has nothing to do', async () => {
    heard.events.length = 0
    const result = await handlers.catchUpMessageHandlers({ deadline: Date.now() + 60_000 })
    expect(result.offered).toBe(1)
    // Everything that will never be offered is settled out of the index: the
    // blocked and junked post, the history, and the week- and month-old mail.
    expect(result.settled).toBe(5)
    expect(heard.events.map((e) => e.messageId)).toEqual([ids.sales])
    expect(await store.unofferedMessageIds(50)).toEqual([])
    // Named rather than counted, so a failure says which row was left.
    const left = await db.$queryRaw<{ subject: string | null; created_at: Date; sent_at: Date; offering_at: Date | null }[]>`
      SELECT "subject", "created_at", "sent_at", "offering_at" FROM "uin_messages"
       WHERE "handled_at" IS NULL AND "direction" = 'in' AND "auto_kind" IS NULL
    `
    expect(left).toEqual([])
    expect(await handlers.catchUpMessageHandlers({ deadline: Date.now() + 60_000 })).toEqual({ offered: 0, settled: 0 })
  })

  it('the button re-offers an inbox’s fortnight whatever was offered before', async () => {
    heard.events.length = 0
    const result = await handlers.reofferInbox(inboxId, { after: null, deadline: Date.now() + 60_000 })
    expect(result).toEqual({ handlers: 1, offered: 2, next: null, done: true })
    expect(heard.events.map((e) => e.messageId)).toEqual([ids.lastWeek, ids.fresh])
  })

  it('names the point it listens on', () => {
    expect(handlers.MESSAGE_RECEIVED_POINT).toBe(POINT)
  })
})
