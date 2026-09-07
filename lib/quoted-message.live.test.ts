import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
// Type only, and the queries are imported inside beforeAll: the shared Prisma
// client is built the first time it is imported and reads DATABASE_URL as it
// goes.
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
// Which message a reply quotes, executed.
//
// Pressing Reply on the fourth message of nine has to quote the fourth message.
// The composer says which one it means, and the lookup that answers is raw SQL
// with a fragment in the middle of it - so tsc sees a template string, eslint
// sees a template string, and a build never executes a query. Every gate in the
// project is green on a WHERE clause Postgres will not parse.
//
// Four claims worth executing rather than reading:
//
// MIGRATION 049 APPLIES AT ALL. It adds the column a half-written reply
// remembers the answered message in, and a foreign key that lets go when the
// message is deleted rather than holding the draft up.
//
// THE LOOKUP IS SCOPED TO THE CONVERSATION. The id comes off a button in
// somebody's browser and the body it names is about to be quoted into an email
// leaving this site. An id belonging to another conversation must find nothing.
//
// A NOTE IS NEVER QUOTABLE. An internal note is written for colleagues on this
// screen. Whatever id is posted, it must not come back out of this query and
// into somebody's outgoing post.
//
// A DRAFT REMEMBERS WHAT IT ANSWERS. Written on Tuesday, sent on Friday, and
// still quoting Tuesday's message - which is a column saved and read back
// through the three-way UPDATE/INSERT/ON CONFLICT that saveDraft assembles.
//
// Skipped unless opted into, so a plain npm test never touches the network:
//
//   RUN_INBOX_QUOTE=1 npx vitest run \
//     modules/unified-inbox/lib/quoted-message.live.test.ts --testTimeout 120000
//
// A SKIP HERE IS A FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_QUOTE === '1'
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

describe.runIf(shouldRun)('the message a reply quotes, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let queries: Db
  let salesId: string
  let threadId: string
  let otherThreadId: string
  let firstId: string
  let newestId: string
  let noteId: string
  let userId: string

  /** A conversation with nothing on it yet. */
  async function seedThread(subject: string): Promise<string> {
    const rows = await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "uin_threads"
         ("inbox_id", "channel", "subject", "subject_normalised", "preview",
          "last_message_at", "last_direction", "unread", "message_count", "status")
       VALUES ($1, 'email', $2, lower($2), $2, now(), 'in', false, 1, 'open')
       RETURNING "id"`,
      salesId,
      subject,
    )
    return rows[0]!.id
  }

  /** One message on it, of whichever kind. */
  async function seedMessage(
    thread: string,
    direction: 'in' | 'out' | 'note',
    body: string,
    sentAt: string,
  ): Promise<string> {
    const rows = await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "uin_messages"
         ("thread_id", "direction", "channel", "from_name", "from_address",
          "to_addresses", "cc_addresses", "subject", "body_text", "sent_at",
          "has_attachments")
       VALUES ($1, $2, 'email', 'Faye Whitmore', 'faye@supplier.example',
               ARRAY['sales@example.co.uk']::text[], ARRAY[]::text[], 'Chairs', $3,
               $4::timestamp, false)
       RETURNING "id"`,
      thread,
      direction,
      body,
      sentAt,
    )
    return rows[0]!.id
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
    database = await createTestDatabase(vps, `cactus_rt_uinquote_${stamp}`, role)
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
    // Every module migration, in order, including 049. If the column and the
    // foreign key it adds are not something Postgres will take, this line is
    // where the suite stops - which is the point of running it here rather than
    // on a customer.
    for (const file of readdirSync(MODULE_MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      await applyFile(path.join(MODULE_MIGRATIONS, file))
    }

    const inboxes = await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "uin_inboxes" ("name", "address") VALUES ('Sales', 'sales@example.co.uk') RETURNING "id"`,
    )
    salesId = inboxes[0]!.id

    // A draft belongs to whoever wrote it, and the column says so with a
    // foreign key, so there has to be somebody real to own one.
    await db.$executeRawUnsafe(`INSERT INTO "Role" ("id", "name") VALUES ('role-staff', 'Staff')`)
    await db.$executeRawUnsafe(
      `INSERT INTO "User" ("id", "email", "username", "roleId", "updatedAt")
       VALUES ('user-writer', 'writer@example.co.uk', 'marcus', 'role-staff', now())`,
    )
    userId = 'user-writer'

    threadId = await seedThread('Chairs')
    otherThreadId = await seedThread('Desks')
    firstId = await seedMessage(threadId, 'in', 'What are the sizes?', '2026-09-01T09:00:00Z')
    noteId = await seedMessage(threadId, 'note', 'Do not quote me on the price.', '2026-09-02T09:00:00Z')
    newestId = await seedMessage(threadId, 'in', 'Do you have them in blue?', '2026-09-03T09:00:00Z')

    queries = await import('./db')
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('hands back the message that was actually answered, not the newest', async () => {
    const parent = await queries.getQuotableMessage(firstId, threadId)
    expect(parent?.id).toBe(firstId)
    expect(parent?.bodyText).toBe('What are the sizes?')
  })

  it('finds nothing for a message belonging to another conversation', async () => {
    expect(await queries.getQuotableMessage(firstId, otherThreadId)).toBeNull()
  })

  it('never hands back an internal note, whatever id is posted at it', async () => {
    expect(await queries.getQuotableMessage(noteId, threadId)).toBeNull()
  })

  it('still answers without a conversation, which is what a retry asks it', async () => {
    // retrySend names a message it has already read off its own row, so there
    // is no conversation to scope by and nothing arriving from a browser.
    const parent = await queries.getQuotableMessage(newestId)
    expect(parent?.id).toBe(newestId)
  })

  it('remembers on a draft which message it answers, and gives it back', async () => {
    const draft = await queries.saveDraft({
      authorUserId: userId,
      inboxId: salesId,
      threadId,
      inReplyToMessageId: firstId,
      mode: 'reply',
      to: ['faye@supplier.example'],
      cc: [],
      subject: 'Re: Chairs',
      body: '<p>They are 45cm.</p>',
      bodyFormat: 'html',
      attachments: [],
    })
    expect(draft.inReplyToMessageId).toBe(firstId)

    const reopened = await queries.getDraft(draft.id, userId)
    expect(reopened?.inReplyToMessageId).toBe(firstId)
  })

  it('lets go of a deleted message rather than holding the draft up', async () => {
    const doomed = await seedMessage(threadId, 'in', 'And in green?', '2026-09-04T09:00:00Z')
    const draft = await queries.saveDraft({
      authorUserId: userId,
      inboxId: salesId,
      threadId: otherThreadId,
      inReplyToMessageId: doomed,
      mode: 'reply',
      to: ['faye@supplier.example'],
      cc: [],
      subject: 'Re: Desks',
      body: '<p>Green as well.</p>',
      bodyFormat: 'html',
      attachments: [],
    })
    expect(draft.inReplyToMessageId).toBe(doomed)

    await db.$executeRawUnsafe(`DELETE FROM "uin_messages" WHERE "id" = $1`, doomed)

    const reopened = await queries.getDraft(draft.id, userId)
    // Still there, and answering the newest again - which is what the send
    // route falls back to. Losing what somebody wrote would be the worse bug.
    expect(reopened?.id).toBe(draft.id)
    expect(reopened?.inReplyToMessageId).toBeNull()
  })
})
