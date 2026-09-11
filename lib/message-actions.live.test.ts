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
// Deleting one message, and moving one out, executed.
//
// `migrations/054_message_deletions.sql` and the two functions that read it are
// raw SQL, and NOTHING else in this repository runs them: `tsc` sees a template
// string, `eslint` sees a template string, a build never executes a query, and
// the module build gate compiles rather than connects. A query Postgres will
// not parse is green everywhere until a customer opens the screen.
//
// And the thing being guarded here cannot be seen in a type at all. Both of
// these are easy to write in a way that works perfectly for ten minutes: the
// row goes, the screen refreshes, the message is gone. What happens afterwards
// is the whole point - the collection's dedupe is a lookup in the very table
// the delete emptied, so a deleted message is filed straight back the next time
// it is seen anywhere the ledger has not walked, and a channel's message comes
// back on the next tick, and the one after that, for ever. That is exactly the
// shape of the bug migration 053 was written to fix one size up.
//
// Eight claims, each about the DATABASE rather than about the TypeScript:
//
//   1. A DELETE TAKES THE MESSAGE AND LEAVES THE CONVERSATION. The row goes,
//      the count under the subject agrees, and the rest of the thread is there.
//   2. A DELETED EMAIL CANNOT BE COLLECTED AGAIN. insertMessage refuses the
//      same Message-ID afterwards - which is what stops the owner archiving it
//      from their phone putting it straight back.
//   3. A DELETED CHANNEL MESSAGE CANNOT BE COPIED BACK IN. insertProviderMessage
//      refuses it even onto the conversation it was deleted from, which is the
//      case that would otherwise repeat every quarter of an hour.
//   4. AND THE GUARD IS NOT A BLANKET REFUSAL. A message nobody deleted still
//      files, on both paths. A tombstone that matched everything would be an
//      inbox that silently stopped collecting.
//   5. A SPLIT MOVES ONE MESSAGE AND FIXES BOTH SIDES. Counters, preview and
//      last-message dates on the conversation it left and the one it made.
//   6. THE NEW CONVERSATION IS BORN WITHOUT A PERSON, so the people pass works
//      out whose it is from its own message rather than inheriting the wrong
//      name - being filed under the wrong person is usually why it is split.
//   7. THE REFUSALS REFUSE. The only message in a conversation, a message a
//      channel owns, and a conversation that has itself been merged away.
//   8. AND THE UNDO IS THE MERGE. Merging the two back together brings the
//      message home, which is the only undo either of these has.
//
// A real throwaway database on the Postgres VPS, built from the core schema and
// this module's own migrations. Named `cactus_rt_*` and dropped afterwards; the
// live site's database sits on the same server and is never named, opened or
// altered.
//
// Skipped unless opted into, so a plain `npm test` never touches the network:
//
//   RUN_INBOX_MESSAGE_ACTIONS=1 npx vitest run \
//     modules/unified-inbox/lib/message-actions.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_MESSAGE_ACTIONS === '1'
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

describe.runIf(shouldRun)('deleting and splitting one message, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: Db
  let applyFile: (file: string) => Promise<void>

  let inbox = ''
  let connection = ''

  const chris = 'user-chris'

  /** A conversation with one email already on it, so there is something for the
   *  second one to be glued to. Returns both ids. */
  const conversationWith = async (
    subject: string,
    identity: string,
  ): Promise<{ threadId: string; messageId: string }> => {
    const threadId = await lib.createThread({
      inboxId: inbox,
      subject,
      subjectNormalised: subject.toLowerCase(),
      preview: 'A quote for eight desks',
      lastMessageAt: new Date('2026-09-01T09:00:00Z'),
      lastDirection: 'in',
      unread: true,
    })
    const messageId = await file(threadId, identity, new Date('2026-09-01T09:00:00Z'))
    expect(messageId).not.toBeNull()
    return { threadId, messageId: messageId! }
  }

  /** One email, filed the way the collection files one. */
  const file = async (
    threadId: string,
    identity: string,
    sentAt: Date,
    uid = Math.floor(Math.random() * 1_000_000),
  ): Promise<string | null> => lib.insertMessage({
    threadId,
    connectionId: connection,
    direction: 'in',
    messageIdHeader: identity,
    inReplyTo: null,
    references: [],
    fromName: 'A Customer',
    fromAddress: 'customer@example.com',
    replyTo: null,
    toAddresses: ['sales@deskwell.co.uk'],
    ccAddresses: [],
    subject: 'Eight desks',
    bodyText: 'Do you do them in oak?',
    bodyHtml: null,
    snippet: 'Do you do them in oak?',
    sentAt,
    hasAttachments: false,
    sizeBytes: 2048,
    imapFolder: 'INBOX',
    imapUid: uid,
    threadMatch: 'heuristic',
    routedOn: 'to',
    autoKind: null,
  })

  /** And one of a channel's, filed the way a collection from a channel files
   *  one. 'demo-chat' is a channel key nothing on this site publishes, which is
   *  the point: the guard is about the pair, not about the module existing. */
  const fileFromChannel = async (
    threadId: string,
    providerMessageId: string,
  ): Promise<string | null> => lib.insertProviderMessage({
    threadId,
    providerModule: 'demo-chat',
    providerMessageId,
    direction: 'in',
    channel: 'chat',
    fromName: 'A Customer',
    fromAddress: 'customer@example.com',
    fromPhone: null,
    subject: 'Live chat',
    bodyText: 'Are you open on Saturday?',
    bodyHtml: null,
    snippet: 'Are you open on Saturday?',
    sentAt: new Date('2026-09-02T10:00:00Z'),
  })

  const messageIdsOn = async (threadId: string): Promise<string[]> =>
    (await lib.listThreadMessages(threadId)).map((m) => m.id)

  const threadRow = async (id: string): Promise<{
    message_count: number
    last_message_at: Date | null
    person_id: string | null
    inbox_id: string | null
    status: string
    preview: string | null
  }> => {
    const rows = await db.$queryRawUnsafe<Array<{
      message_count: number
      last_message_at: Date | null
      person_id: string | null
      inbox_id: string | null
      status: string
      preview: string | null
    }>>(
      `SELECT "message_count", "last_message_at", "person_id", "inbox_id", "status", "preview"
         FROM "uin_threads" WHERE "id" = $1`,
      id,
    )
    return rows[0]!
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
    database = await createTestDatabase(vps, `cactus_rt_uinmsg_${stamp}`, role)
    process.env.DATABASE_URL = database.connectionUri
    process.env.ENCRYPTION_KEY = KEY

    const { stalePlanRetryExtension } = await import('@/lib/db/prisma')
    const { splitSqlStatements } = await import('@/lib/backup/restore')
    db = await connect(database.connectionUri, stalePlanRetryExtension)

    applyFile = async (file: string) => {
      for (const statement of splitSqlStatements(readFileSync(file, 'utf8'))) {
        await db.$executeRawUnsafe(statement)
      }
    }
    await applyFile(CORE_SCHEMA)
    for (const file of readdirSync(MODULE_MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      await applyFile(path.join(MODULE_MIGRATIONS, file))
    }

    lib = await import('./db')

    // A real person: the event rows both actions write carry a foreign key to
    // "User", and an event that cannot be written would abort the transaction
    // the delete is in.
    await db.$executeRawUnsafe(`INSERT INTO "Role" ("id", "name") VALUES ('role-staff', 'Staff')`)
    await db.$executeRawUnsafe(
      `INSERT INTO "User" ("id", "email", "username", "roleId", "updatedAt")
       VALUES ($1, 'chris@deskwell.co.uk', 'chris', 'role-staff', now())`,
      chris,
    )

    inbox = (await lib.createInbox({ name: 'Sales', address: 'sales@deskwell.co.uk' })).id
    connection = (await lib.createConnection({
      label: 'Mailbox',
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapUsername: 'sales@deskwell.co.uk',
      imapPassword: 'not-a-real-password',
    })).id
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('takes one message out and leaves the conversation standing', async () => {
    const { threadId, messageId } = await conversationWith('Eight desks 1', 'first-1@example.com')
    const stray = await file(threadId, 'stray-1@example.com', new Date('2026-09-03T09:00:00Z'))
    expect(stray).not.toBeNull()

    const message = await lib.messageForAction(stray!)
    expect(message).not.toBeNull()
    expect(message!.siblings).toBe(2)

    await lib.deleteMessageHere(message!, chris)

    // Claim 1: the row is gone, the one it was filed beside is not, and the
    // count under the subject agrees with the list rather than with itself.
    expect(await messageIdsOn(threadId)).toEqual([messageId])
    expect((await threadRow(threadId)).message_count).toBe(1)

    // And it is said out loud in the log, with nothing of the message in it.
    const events = await db.$queryRawUnsafe<Array<{ kind: string; detail: unknown }>>(
      `SELECT "kind", "detail" FROM "uin_events" WHERE "thread_id" = $1`, threadId,
    )
    expect(events.map((e) => e.kind)).toContain('message_deleted')
    expect(events.find((e) => e.kind === 'message_deleted')?.detail).toBeNull()
  })

  it('will not collect a deleted email a second time, however it is found again', async () => {
    const { threadId } = await conversationWith('Eight desks 2', 'first-2@example.com')
    const stray = await file(threadId, 'stray-2@example.com', new Date('2026-09-03T09:00:00Z'))
    await lib.deleteMessageHere((await lib.messageForAction(stray!))!, chris)

    // Claim 2. The same Message-ID at a different location, which is precisely
    // what the owner filing it into the archive from their phone looks like:
    // the location ledger has not seen that UID, the dedupe on the message
    // table misses because the row has gone, and without the gravestone this
    // files it as a discovery.
    const again = await file(threadId, 'stray-2@example.com', new Date('2026-09-03T09:00:00Z'))
    expect(again).toBeNull()
    expect((await threadRow(threadId)).message_count).toBe(1)

    // On a different conversation as well: the line is drawn against the
    // message, not against where it happened to be filed.
    const elsewhere = await conversationWith('Eight desks 2b', 'first-2b@example.com')
    expect(await file(elsewhere.threadId, 'stray-2@example.com', new Date())).toBeNull()

    // Claim 4: and a message nobody deleted still files perfectly well.
    expect(await file(threadId, 'innocent-2@example.com', new Date('2026-09-04T09:00:00Z'))).not.toBeNull()
  })

  it('will not copy a deleted channel message back in on the next collection', async () => {
    const threadId = (await lib.upsertProviderThread({
      providerModule: 'demo-chat',
      externalId: 'chat-3',
      channel: 'chat',
      subject: 'Live chat',
      subjectNormalised: 'live chat',
      preview: 'Are you open on Saturday?',
      lastMessageAt: new Date('2026-09-02T10:00:00Z'),
      lastDirection: 'in',
      unread: true,
      inboxId: null,
      sourceLabel: 'Live chat',
    })).id

    const kept = await fileFromChannel(threadId, 'chat-msg-1')
    const doomed = await fileFromChannel(threadId, 'chat-msg-2')
    expect(kept).not.toBeNull()
    expect(doomed).not.toBeNull()

    await lib.deleteMessageHere((await lib.messageForAction(doomed!))!, chris)

    // Claim 3. The channel still holds every word of it and hands the whole
    // conversation back on every collection, so this is the exact call the next
    // tick makes - onto the very conversation it was deleted from, where the
    // dedupe on (thread, the channel's own id) now misses.
    expect(await fileFromChannel(threadId, 'chat-msg-2')).toBeNull()
    expect(await messageIdsOn(threadId)).toEqual([kept])

    // Claim 4 on this path too.
    expect(await fileFromChannel(threadId, 'chat-msg-3')).not.toBeNull()
  })

  it('moves one message out onto a conversation of its own and settles both sides', async () => {
    const { threadId, messageId } = await conversationWith('Eight desks 4', 'first-4@example.com')
    const stray = await file(threadId, 'stray-4@example.com', new Date('2026-09-05T11:00:00Z'))

    // Whose it is, filed wrongly - which is the ordinary reason somebody splits
    // a message out in the first place.
    const person = await lib.createPerson({
      displayName: 'Someone Else',
      primaryEmail: 'someone-else@example.com',
      organisationId: null,
    })
    await db.$executeRawUnsafe(
      `UPDATE "uin_threads" SET "person_id" = $1 WHERE "id" = $2`, person, threadId,
    )

    const result = await lib.splitMessageToNewThread((await lib.messageForAction(stray!))!, chris)
    expect('error' in result).toBe(false)
    const newThreadId = (result as { threadId: string }).threadId

    // Claim 5: one message each side, and both counts worked out from the rows
    // rather than adjusted by hand.
    expect(await messageIdsOn(threadId)).toEqual([messageId])
    expect(await messageIdsOn(newThreadId)).toEqual([stray])
    const left = await threadRow(threadId)
    const made = await threadRow(newThreadId)
    expect(left.message_count).toBe(1)
    expect(made.message_count).toBe(1)
    expect(left.last_message_at?.toISOString()).toBe('2026-09-01T09:00:00.000Z')
    expect(made.last_message_at?.toISOString()).toBe('2026-09-05T11:00:00.000Z')

    // It keeps the address it was in, or it would vanish out of the tab
    // somebody split it from.
    expect(made.inbox_id).toBe(inbox)
    // Claim 6: and NOT the person it was wrongly filed under. Null is what the
    // people pass looks for, so the next tick works it out from its own message.
    expect(made.person_id).toBeNull()

    // Both sides say what happened, so the log reads either way round.
    const kinds = await db.$queryRawUnsafe<Array<{ kind: string }>>(
      `SELECT "kind" FROM "uin_events" WHERE "thread_id" = ANY($1::text[])`,
      [threadId, newThreadId],
    )
    expect(kinds.map((k) => k.kind)).toContain('message_split')
    expect(kinds.map((k) => k.kind)).toContain('split_from')

    // Claim 8: merging the two back together is the only undo either action
    // has, and it has to actually work.
    const merged = await lib.mergeThreads(threadId, [newThreadId], chris)
    expect('error' in merged).toBe(false)
    expect((await messageIdsOn(threadId)).sort()).toEqual([messageId, stray].sort())
  })

  it('refuses the splits that would leave something worse than it found it', async () => {
    // The only message in a conversation is already on one of its own.
    const alone = await conversationWith('Eight desks 5', 'first-5@example.com')
    const onlyOne = await lib.splitMessageToNewThread(
      (await lib.messageForAction(alone.messageId))!, chris,
    )
    expect(onlyOne).toEqual({ error: expect.stringContaining('only message') })

    // A channel's message is a copy of something the owning module still holds
    // and would offer straight back on the next collection, onto the
    // conversation it came from - so we would be holding it twice.
    const chatThread = (await lib.upsertProviderThread({
      providerModule: 'demo-chat',
      externalId: 'chat-5',
      channel: 'chat',
      subject: 'Live chat',
      subjectNormalised: 'live chat',
      preview: 'Hello',
      lastMessageAt: new Date('2026-09-02T10:00:00Z'),
      lastDirection: 'in',
      unread: true,
      inboxId: null,
      sourceLabel: 'Live chat',
    })).id
    await fileFromChannel(chatThread, 'chat-5-a')
    const second = await fileFromChannel(chatThread, 'chat-5-b')
    const channelOwned = await lib.splitMessageToNewThread(
      (await lib.messageForAction(second!))!, chris,
    )
    expect(channelOwned).toEqual({ error: expect.stringContaining('another part of the site') })

    // And a conversation that has itself been merged away is not one to be
    // moving messages out of: it is not on any list, so the new conversation
    // would be made out of something nobody can see.
    const winner = await conversationWith('Eight desks 6', 'first-6@example.com')
    const loser = await conversationWith('Eight desks 7', 'first-7@example.com')
    const extra = await file(loser.threadId, 'stray-7@example.com', new Date('2026-09-06T09:00:00Z'))
    await lib.mergeThreads(winner.threadId, [loser.threadId], chris)
    // The messages moved with the merge, so ask about one that did not: the
    // losing conversation's own row is what is being refused here.
    await db.$executeRawUnsafe(
      `UPDATE "uin_messages" SET "thread_id" = $1 WHERE "id" = $2`, loser.threadId, extra,
    )
    const mergedAway = await lib.splitMessageToNewThread(
      (await lib.messageForAction(extra!))!, chris,
    )
    expect(mergedAway).toEqual({ error: expect.stringContaining('merged into another one') })
  })
})
