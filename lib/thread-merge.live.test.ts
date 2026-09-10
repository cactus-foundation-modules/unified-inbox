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
// Merging conversations, executed.
//
// `migrations/031_thread_merges.sql` and everything in db.ts that reads it are
// raw SQL, and NOTHING else in this repository runs a line of it. `tsc` sees a
// template string. `eslint` sees a template string. A build never executes a
// query, and the module build gate compiles rather than connects. A merge that
// trips over a unique index halfway through, an UPDATE with a column name that
// does not exist, a WHERE that quietly matches nothing - all of them are green
// everywhere except here.
//
// And the failures this feature can have are the quiet kind. A merge that files
// messages onto a conversation no list shows loses them until somebody notices
// they are gone. A merge that leaves the losing side visible shows an empty
// conversation for ever. A merge that widens who can read something is a
// privacy breach that looks exactly like a tidy inbox.
//
// A real throwaway database on the Postgres VPS, built from the core schema and
// this module's own migrations. Named `cactus_rt_*` and dropped afterwards; the
// live site's database sits on the same server and is never named, opened or
// altered.
//
// Skipped unless opted into, so a plain `npm test` never touches the network:
//
//   RUN_INBOX_MERGE_GUARDS=1 npx vitest run \
//     modules/unified-inbox/lib/thread-merge.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_MERGE_GUARDS === '1'
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

const SENT_AT = new Date('2026-09-02T10:00:00.000Z')
const LATER = new Date('2026-09-03T10:00:00.000Z')

describe.runIf(shouldRun)('merging conversations, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: Db

  let connectionId = ''
  let chrisInbox = ''
  let marcusInbox = ''

  /** A conversation with one message on it, ready to be merged with another. */
  async function conversation(over: {
    inboxId: string | null
    subject?: string
    messageId?: string
    direction?: 'in' | 'out'
    unread?: boolean
    status?: 'open' | 'done'
    sentAt?: Date
    internalKey?: string | null
  }): Promise<string> {
    const subject = over.subject ?? 'Artisan Furniture'
    const threadId = await lib.createThread({
      inboxId: over.inboxId,
      subject,
      subjectNormalised: subject.toLowerCase(),
      preview: 'Are we still on for Tuesday?',
      lastMessageAt: over.sentAt ?? SENT_AT,
      lastDirection: over.direction ?? 'in',
      unread: over.unread ?? false,
    })
    await lib.insertMessage({
      threadId,
      connectionId,
      direction: over.direction ?? 'in',
      messageIdHeader: over.messageId ?? `${threadId}@deskwell.co.uk`,
      inReplyTo: null,
      references: [],
      fromName: 'A Customer',
      fromAddress: 'customer@example.com',
      replyTo: null,
      toAddresses: ['chris@deskwell.co.uk'],
      ccAddresses: [],
      subject,
      bodyText: 'Are we still on for Tuesday?',
      bodyHtml: null,
      snippet: 'Are we still on for Tuesday?',
      sentAt: over.sentAt ?? SENT_AT,
      hasAttachments: false,
      sizeBytes: 2048,
      imapFolder: 'INBOX',
      imapUid: Math.floor(Math.random() * 1_000_000),
      threadMatch: 'new',
      routedOn: 'to',
      autoKind: null,
      internalKey: over.internalKey ?? null,
    })
    if (over.status === 'done') {
      await lib.setThreadStatus(threadId, 'done', null)
    }
    return threadId
  }

  async function messageCount(threadId: string): Promise<number> {
    const rows = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
      'SELECT COUNT(*)::bigint AS count FROM "uin_messages" WHERE "thread_id" = $1',
      threadId,
    )
    return Number(rows[0]?.count ?? 0)
  }

  /** Whose lists these are. Every list in the module is one person's now -
   *  "this is junk" is a reader's opinion rather than a fact about the mail
   *  (see migrations/041_spam.sql) - and nothing here marks anything as junk,
   *  so any consistent reader will do. */
  const viewer = 'user-viewer'
  const filters = (over: Partial<Parameters<Db['listThreads']>[0]> = {}) => ({
    viewerUserId: viewer,
    inboxIds: [chrisInbox, marcusInbox],
    includeUnrouted: true,
    status: 'all' as const,
    page: 1,
    perPage: 50,
    ...over,
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
    database = await createTestDatabase(vps, `cactus_rt_uinmrg_${stamp}`, role)
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

    chrisInbox = (await lib.createInbox({
      name: 'Chris', address: 'chris@deskwell.co.uk', connectionId,
    })).id
    marcusInbox = (await lib.createInbox({
      name: 'Marcus Ashford', address: 'marcus@deskwell.co.uk', connectionId,
    })).id
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('moves the messages across and hides the conversation they came from', async () => {
    const winner = await conversation({ inboxId: chrisInbox, subject: 'Desks' })
    const loser = await conversation({ inboxId: chrisInbox, subject: 'Desks again', sentAt: LATER })

    const result = await lib.mergeThreads(winner, [loser], null)
    expect(result).not.toHaveProperty('error')

    expect(await messageCount(winner)).toBe(2)
    expect(await messageCount(loser)).toBe(0)

    const detail = await lib.getThreadDetail(loser)
    expect(detail?.mergedIntoId).toBe(winner)

    const listed = await lib.listThreads(filters())
    expect(listed.map((r) => r.id)).toContain(winner)
    expect(listed.map((r) => r.id)).not.toContain(loser)

    // The count and the list have to agree, or a page says "1 of 2".
    const ids = new Set(listed.map((r) => r.id))
    expect(await lib.countThreads(filters())).toBe(ids.size)
  })

  it('keeps the winner counting its own messages', async () => {
    const winner = await conversation({ inboxId: chrisInbox, subject: 'Chairs' })
    const loser = await conversation({ inboxId: chrisInbox, subject: 'Chairs again', sentAt: LATER })
    await lib.mergeThreads(winner, [loser], null)

    const detail = await lib.getThreadDetail(winner)
    expect(detail?.messageCount).toBe(2)
    // The newer of the two, which is the loser's, so the list sorts the merged
    // conversation by when something last actually arrived.
    expect(detail?.lastMessageAt?.toISOString()).toBe(LATER.toISOString())
  })

  it('leaves a copy the winner already holds where it is, rather than losing it', async () => {
    // The two sides of one internal email (020_internal_threads.sql): same
    // Message-ID, same account, two conversations. Every message on the loser
    // would collide with the unique index on the way across.
    const shared = 'one-email@deskwell.co.uk'
    const winner = await conversation({
      inboxId: chrisInbox, subject: 'Tuesday', messageId: shared, direction: 'out',
    })
    const loser = await conversation({
      inboxId: marcusInbox, subject: 'Tuesday', messageId: shared, direction: 'in',
    })

    const result = await lib.mergeThreads(winner, [loser], null)
    expect(result).not.toHaveProperty('error')

    // One copy on the merged conversation, and the duplicate still on the
    // hidden one - so undoing puts a whole conversation back rather than an
    // empty shell.
    expect(await messageCount(winner)).toBe(1)
    expect(await messageCount(loser)).toBe(1)
  })

  it('gives the merged conversation both addresses, and shows it in both tabs', async () => {
    const winner = await conversation({ inboxId: chrisInbox, subject: 'The Henderson order' })
    const loser = await conversation({ inboxId: marcusInbox, subject: 'Henderson', sentAt: LATER })
    await lib.mergeThreads(winner, [loser], null)

    const detail = await lib.getThreadDetail(winner)
    expect([...(detail?.absorbedInboxIds ?? [])].sort()).toEqual([chrisInbox, marcusInbox].sort())

    for (const inboxId of [chrisInbox, marcusInbox]) {
      const rows = await lib.listThreads(filters({ inboxId }))
      expect(rows.map((r) => r.id), `visible in ${inboxId}`).toContain(winner)
      expect(rows.map((r) => r.id)).not.toContain(loser)
    }
  })

  it('counts an unread merged conversation once under each of its addresses', async () => {
    const winner = await conversation({ inboxId: chrisInbox, subject: 'Unread one', unread: true })
    const loser = await conversation({ inboxId: marcusInbox, subject: 'Unread two', sentAt: LATER })
    await lib.mergeThreads(winner, [loser], null)

    const counts = await lib.openCounts(viewer, [chrisInbox, marcusInbox], false, [])
    expect(counts[chrisInbox] ?? 0).toBeGreaterThan(0)
    expect(counts[marcusInbox] ?? 0).toBeGreaterThan(0)
  })

  it('keeps an unanswered half unanswered', async () => {
    const winner = await conversation({ inboxId: chrisInbox, subject: 'Finished', status: 'done' })
    const loser = await conversation({
      inboxId: chrisInbox, subject: 'Still waiting', unread: true, sentAt: LATER,
    })
    await lib.mergeThreads(winner, [loser], null)

    const detail = await lib.getThreadDetail(winner)
    // Marking something done because the OTHER half of it was dealt with is how
    // a customer waiting on an answer disappears off the list.
    expect(detail?.status).toBe('open')
    expect(detail?.unread).toBe(true)
  })

  it('sends a reply to a merged-away message to the conversation it became', async () => {
    const shared = 'ancestor@example.com'
    const winner = await conversation({ inboxId: chrisInbox, subject: 'Quote' })
    const loser = await conversation({
      inboxId: marcusInbox, subject: 'Quote please', messageId: shared, sentAt: LATER,
    })
    await lib.mergeThreads(winner, [loser], null)

    const refs = await lib.threadsForMessageIds([shared])
    const found = refs.get(shared) ?? []
    // The message moved, so its id leads to the merged conversation. Nothing
    // may lead to the hidden one, or the reply would land where nobody looks.
    expect(found.map((r) => r.threadId)).toEqual([winner])
    expect([...(found[0]?.absorbedInboxIds ?? [])].sort()).toEqual([chrisInbox, marcusInbox].sort())
  })

  it('never leads a reply to a duplicate left on the hidden conversation', async () => {
    const shared = 'both-sides@deskwell.co.uk'
    const winner = await conversation({
      inboxId: chrisInbox, subject: 'Thursday', messageId: shared, direction: 'out',
    })
    const loser = await conversation({
      inboxId: marcusInbox, subject: 'Thursday', messageId: shared, direction: 'in',
    })
    await lib.mergeThreads(winner, [loser], null)

    const found = (await lib.threadsForMessageIds([shared])).get(shared) ?? []
    expect(found.map((r) => r.threadId)).toEqual([winner])
  })

  it('does not offer a merged-away conversation to the subject heuristic', async () => {
    const winner = await conversation({ inboxId: chrisInbox, subject: 'Bookcases' })
    const loser = await conversation({ inboxId: chrisInbox, subject: 'Bookcases', sentAt: LATER })
    await lib.mergeThreads(winner, [loser], null)

    const candidates = await lib.candidateThreads('bookcases', new Date('2026-08-01T00:00:00.000Z'))
    expect(candidates.map((c) => c.id)).toContain(winner)
    expect(candidates.map((c) => c.id)).not.toContain(loser)
  })

  it('drops a record link the winner already had, and moves the rest', async () => {
    const winner = await conversation({ inboxId: chrisInbox, subject: 'Invoices' })
    const loser = await conversation({ inboxId: chrisInbox, subject: 'Invoice 900', sentAt: LATER })
    const link = {
      personId: null, moduleName: 'shop', recordType: 'order',
      label: 'Order 900', confidence: 100, linkedBy: 'auto' as const,
    }
    // The same order attached to both, which would collide on the unique index -
    // and a merge that fails because of it is a merge nobody can complete.
    await lib.recordLink({ ...link, threadId: winner, recordId: '900' })
    await lib.recordLink({ ...link, threadId: loser, recordId: '900' })
    await lib.recordLink({ ...link, threadId: loser, recordId: '901', label: 'Order 901' })

    const result = await lib.mergeThreads(winner, [loser], null)
    expect(result).not.toHaveProperty('error')

    const links = await lib.linksForThread(winner)
    expect([...links.map((l) => l.recordId)].sort()).toEqual(['900', '901'])
  })

  it('puts a merge back, messages and addresses and all', async () => {
    const winner = await conversation({ inboxId: chrisInbox, subject: 'Filing cabinets' })
    const loser = await conversation({ inboxId: marcusInbox, subject: 'Cabinets', sentAt: LATER })
    const result = await lib.mergeThreads(winner, [loser], null)
    if ('error' in result) throw new Error(result.error)

    const undone = await lib.undoThreadMerge(result.mergeIds[0]!, null)
    expect(undone).not.toHaveProperty('error')

    expect(await messageCount(winner)).toBe(1)
    expect(await messageCount(loser)).toBe(1)

    const back = await lib.getThreadDetail(loser)
    expect(back?.mergedIntoId).toBeNull()
    expect(back?.messageCount).toBe(1)

    // The winner belongs to its own address again and to nothing else, so the
    // other address stops being able to read it.
    const after = await lib.getThreadDetail(winner)
    expect(after?.absorbedInboxIds).toEqual([])

    const rows = await lib.listThreads(filters())
    expect(rows.map((r) => r.id)).toContain(loser)
  })

  it('refuses to undo the same merge twice', async () => {
    const winner = await conversation({ inboxId: chrisInbox, subject: 'Pedestals' })
    const loser = await conversation({ inboxId: chrisInbox, subject: 'Pedestal', sentAt: LATER })
    const result = await lib.mergeThreads(winner, [loser], null)
    if ('error' in result) throw new Error(result.error)

    expect(await lib.undoThreadMerge(result.mergeIds[0]!, null)).not.toHaveProperty('error')
    expect(await lib.undoThreadMerge(result.mergeIds[0]!, null)).toHaveProperty('error')
  })

  it('refuses to merge into something that has itself been merged away', async () => {
    const winner = await conversation({ inboxId: chrisInbox, subject: 'Screens' })
    const loser = await conversation({ inboxId: chrisInbox, subject: 'Screen', sentAt: LATER })
    const third = await conversation({ inboxId: chrisInbox, subject: 'Screens too', sentAt: LATER })
    await lib.mergeThreads(winner, [loser], null)

    // Filing onto a conversation no list shows is how messages go missing.
    expect(await lib.mergeThreads(loser, [third], null)).toHaveProperty('error')
  })

  it('flattens a chain rather than leaving a pointer at a pointer', async () => {
    const a = await conversation({ inboxId: chrisInbox, subject: 'Chain one' })
    const b = await conversation({ inboxId: chrisInbox, subject: 'Chain two', sentAt: LATER })
    const c = await conversation({ inboxId: marcusInbox, subject: 'Chain three' })

    await lib.mergeThreads(b, [a], null)
    await lib.mergeThreads(c, [b], null)

    // A points at C now, not at B: "what did this become?" stays one hop, which
    // is what every read of the pointer assumes.
    expect((await lib.getThreadDetail(a))?.mergedIntoId).toBe(c)
    expect((await lib.getThreadDetail(b))?.mergedIntoId).toBe(c)
    expect(await messageCount(c)).toBe(3)
  })

  it('keeps an earlier merge intact when the conversation is merged onwards', async () => {
    const a = await conversation({ inboxId: chrisInbox, subject: 'Nested A' })
    const b = await conversation({ inboxId: chrisInbox, subject: 'Nested B', sentAt: LATER })
    const c = await conversation({ inboxId: marcusInbox, subject: 'Nested C' })

    const first = await lib.mergeThreads(b, [a], null)
    if ('error' in first) throw new Error(first.error)
    const second = await lib.mergeThreads(c, [b], null)
    if ('error' in second) throw new Error(second.error)

    expect(await messageCount(c)).toBe(3)

    // Undoing the OUTER merge must bring the inner merge's messages back with
    // it - the rows A contributed are B's to hold until A's own merge is undone.
    expect(await lib.undoThreadMerge(second.mergeIds[0]!, null)).not.toHaveProperty('error')
    expect(await messageCount(b)).toBe(2)
    expect(await messageCount(c)).toBe(1)
    expect((await lib.getThreadDetail(a))?.mergedIntoId).toBe(b)

    // And then the inner one on its own, which is the whole point of keeping
    // the two records apart.
    expect(await lib.undoThreadMerge(first.mergeIds[0]!, null)).not.toHaveProperty('error')
    expect(await messageCount(a)).toBe(1)
    expect(await messageCount(b)).toBe(1)
    expect((await lib.getThreadDetail(a))?.mergedIntoId).toBeNull()
  })

  it('still finds a twice-moved message for the conversation it started on', async () => {
    const a = await conversation({ inboxId: chrisInbox, subject: 'Provenance A' })
    const b = await conversation({ inboxId: chrisInbox, subject: 'Provenance B', sentAt: LATER })
    const c = await conversation({ inboxId: chrisInbox, subject: 'Provenance C' })
    await lib.mergeThreads(b, [a], null)
    await lib.mergeThreads(c, [b], null)

    // Overwriting the provenance on the second move would exempt A's message
    // from A's own erasure, because erasure finds it by exactly that column.
    const exported = await lib.exportMessagesForThreads([a])
    expect(exported).toHaveLength(1)
    expect(exported[0]?.threadId).toBe(a)

    await lib.deleteThreads([a])
    expect(await messageCount(c)).toBe(2)
  })

  it('sends a provider its merged-away conversation, not the hidden one', async () => {
    const chatThread = await lib.createThread({
      inboxId: null,
      subject: 'Live chat',
      subjectNormalised: 'live chat',
      preview: 'Hello?',
      lastMessageAt: SENT_AT,
      lastDirection: 'in',
      unread: true,
    })
    await db.$executeRawUnsafe(
      'UPDATE "uin_threads" SET "provider_module" = $1, "external_id" = $2 WHERE "id" = $3',
      'live-chat', 'conv-4471', chatThread,
    )
    const winner = await conversation({ inboxId: chrisInbox, subject: 'About the chat' })
    await lib.mergeThreads(winner, [chatThread], null)

    // Reading the row straight would hand the customer's next chat message to a
    // conversation nothing shows, and it would simply never appear.
    const state = await lib.providerThreadState('live-chat', 'conv-4471')
    expect(state?.id).toBe(winner)
  })

  it('takes the hidden side with it when the conversation is deleted', async () => {
    const winner = await conversation({ inboxId: chrisInbox, subject: 'Old one' })
    const loser = await conversation({ inboxId: chrisInbox, subject: 'Old two', sentAt: LATER })
    await lib.mergeThreads(winner, [loser], null)

    await lib.deleteThreads([winner])

    // merged_into_id is ON DELETE SET NULL, so a loser left behind would stop
    // being merged away and reappear holding nothing but duplicates.
    expect(await lib.getThreadDetail(loser)).toBeNull()
  })

  it('takes a person’s moved messages with their conversation when they are erased', async () => {
    const theirs = await conversation({ inboxId: chrisInbox, subject: 'Theirs', sentAt: LATER })
    const somebodyElses = await conversation({ inboxId: chrisInbox, subject: 'Somebody else' })
    await lib.mergeThreads(somebodyElses, [theirs], null)

    // Their words are on another person's conversation now. Deleting only the
    // conversation they came from would leave them there, readable, after the
    // erasure said they had gone.
    await lib.deleteThreads([theirs])
    expect(await messageCount(somebodyElses)).toBe(1)
  })

  it('exports a moved message under the conversation it came from', async () => {
    const origin = await conversation({ inboxId: chrisInbox, subject: 'Origin', sentAt: LATER })
    const winner = await conversation({ inboxId: chrisInbox, subject: 'Winner' })
    await lib.mergeThreads(winner, [origin], null)

    const exported = await lib.exportMessagesForThreads([origin])
    // An export with a hole in it is worse than no export: it looks complete.
    expect(exported).toHaveLength(1)
    expect(exported[0]?.threadId).toBe(origin)
  })
})
