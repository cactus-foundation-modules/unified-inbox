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
// Being asked to look at something, executed.
//
// `migrations/032_mentions.sql` and the nine helpers that read and write it are
// raw SQL, and NOTHING else in this repository runs them: `tsc` sees a template
// string, `eslint` sees a template string, a build never executes a query, and
// the module build gate compiles rather than connects. A query Postgres will
// not parse is green everywhere until a customer opens the screen.
//
// Four claims are worth the network round trip, and every one of them is a
// claim about the DATABASE rather than about the TypeScript:
//
//   1. ON CONFLICT ("thread_id", "user_id") - asked twice is one job, reopened,
//      not two jobs side by side. The unique index is what makes that true and
//      the upsert is what spends it.
//   2. The UPDATE is scoped by user_id, so one colleague cannot settle another
//      colleague's ask by guessing an id.
//   3. The list's LATERAL join and the explicit NULL casts in the single-row
//      read both parse and come back in the shapes the mapper expects.
//   4. The foreign keys behave: the conversation going takes the ask with it,
//      the person going takes their own list, and whoever ASKED going leaves
//      the work behind, because the work was never theirs.
//
// A real throwaway database on the Postgres VPS, built from the core schema and
// this module's own migrations. Named `cactus_rt_*` and dropped afterwards; the
// live site's database sits on the same server and is never named, opened or
// altered.
//
// Skipped unless opted into, so a plain `npm test` never touches the network:
//
//   RUN_INBOX_MENTION_GUARDS=1 npx vitest run \
//     modules/unified-inbox/lib/mentions.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_MENTION_GUARDS === '1'
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

describe.runIf(shouldRun)('asking a colleague to look, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: Db

  let accounts = ''
  let order = ''
  let query = ''
  let noteId = ''
  const emma = 'user-emma'
  const marcus = 'user-marcus'
  const sam = 'user-sam'

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
    database = await createTestDatabase(vps, `cactus_rt_uinment_${stamp}`, role)
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

    // Three real people: the foreign keys to "User" are part of what is tested.
    await db.$executeRawUnsafe(`INSERT INTO "Role" ("id", "name") VALUES ('role-staff', 'Staff')`)
    for (const [id, email, username] of [
      [emma, 'emma@deskwell.co.uk', 'emma'],
      [marcus, 'marcus@deskwell.co.uk', 'marcus'],
      [sam, 'sam@deskwell.co.uk', 'sam'],
    ]) {
      await db.$executeRawUnsafe(
        `INSERT INTO "User" ("id", "email", "username", "roleId", "updatedAt")
         VALUES ($1, $2, $3, 'role-staff', now())`,
        id, email, username,
      )
    }

    const connection = await lib.createConnection({
      label: 'iCloud',
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapUsername: 'someone@example.com',
      imapPassword: 'nothing-real',
    })
    accounts = (await lib.createInbox({
      name: 'Accounts',
      address: 'accounts@deskwell.co.uk',
      connectionId: connection.id,
    })).id

    order = await lib.createDiscussionThread({
      inboxId: accounts,
      subject: 'The Henderson order',
      subjectNormalised: 'the henderson order',
      preview: 'Something about the Henderson order',
      startedByUserId: emma,
      toUserIds: [sam],
    })
    query = await lib.createDiscussionThread({
      inboxId: accounts,
      subject: 'That invoice query',
      subjectNormalised: 'that invoice query',
      preview: 'Something about an invoice',
      startedByUserId: emma,
      toUserIds: [sam],
    })

    // A real message from a customer, so the list's LATERAL join has something
    // to find. Notes are excluded from it by design - "who is this with" is
    // never one of us talking among ourselves.
    await db.$executeRawUnsafe(
      `INSERT INTO "uin_messages"
         ("thread_id", "direction", "channel", "from_name", "from_address", "to_addresses",
          "body_text", "snippet", "sent_at", "source")
       VALUES ($1, 'in', 'email', 'Jane Henderson', 'jane@henderson.example',
               ARRAY['accounts@deskwell.co.uk'], 'Where is my desk', 'Where is my desk',
               now(), 'imap')`,
      order,
    )

    noteId = await lib.insertNote({
      threadId: order,
      channel: 'discussion',
      bodyHtml: 'Sam, can you look at this',
      bodyText: 'Sam, can you look at this',
      authorUserId: marcus,
    })
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('starts with nobody having been asked about anything', async () => {
    expect(await lib.hasMentionOn(order, sam)).toBe(false)
    expect(await lib.openMentionCount(sam)).toBe(0)
    expect(await lib.listMentions({ userId: sam, status: 'all', page: 1, perPage: 25 })).toEqual([])
    expect(await lib.mentionForThread(sam, order)).toBeNull()
  })

  it('records an ask, and reads it back with the conversation beside it', async () => {
    await lib.upsertMention({
      threadId: order,
      userId: sam,
      byUserId: marcus,
      messageId: noteId,
      note: 'Sam, can you look at this',
    })

    expect(await lib.hasMentionOn(order, sam)).toBe(true)
    // The grant is one conversation for one person, not the address it sits in.
    expect(await lib.hasMentionOn(query, sam)).toBe(false)
    expect(await lib.hasMentionOn(order, emma)).toBe(false)

    const rows = await lib.listMentions({ userId: sam, status: 'open', page: 1, perPage: 25 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      threadId: order,
      status: 'open',
      byUserId: marcus,
      note: 'Sam, can you look at this',
      subject: 'The Henderson order',
      channel: 'discussion',
      inboxId: accounts,
      // Out of the LATERAL join, and never out of the note: one of us writing
      // to the others is not who the conversation is with.
      participantName: 'Jane Henderson',
      participantAddress: 'jane@henderson.example',
    })

    // The single-row read takes a different path - explicit NULL casts standing
    // in for the join - so it is checked rather than assumed.
    expect(await lib.mentionForThread(sam, order)).toMatchObject({
      threadId: order,
      status: 'open',
      byUserId: marcus,
      subject: 'The Henderson order',
      participantName: null,
      participantAddress: null,
    })
  })

  it('is one job per person per conversation, however often they are asked', async () => {
    await lib.setMentionStatus({
      id: (await lib.mentionForThread(sam, order))!.id,
      userId: sam,
      status: 'done',
      until: null,
    })
    expect((await lib.mentionForThread(sam, order))?.status).toBe('done')

    // Asked again a fortnight later: the SAME job comes back open with the new
    // note against it, rather than a second one appearing beside the finished
    // one. This is the unique index earning its keep.
    await lib.upsertMention({
      threadId: order,
      userId: sam,
      byUserId: emma,
      messageId: noteId,
      note: 'Any luck with this one?',
    })
    const rows = await lib.listMentions({ userId: sam, status: 'all', page: 1, perPage: 25 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      status: 'open',
      byUserId: emma,
      note: 'Any luck with this one?',
    })
  })

  it('counts each state, and the rail counts only what is waiting', async () => {
    await lib.upsertMention({
      threadId: query, userId: sam, byUserId: marcus, messageId: null, note: 'And this one',
    })
    // One for somebody else entirely, to prove the scoping is in the SQL.
    await lib.upsertMention({
      threadId: order, userId: emma, byUserId: marcus, messageId: null, note: 'Emma too',
    })

    const second = await lib.mentionForThread(sam, query)
    const later = new Date(Date.now() + 60 * 60 * 1000)
    await lib.setMentionStatus({ id: second!.id, userId: sam, status: 'snoozed', until: later })

    expect(await lib.mentionStatusCounts(sam)).toEqual({ open: 1, snoozed: 1, done: 0, all: 2 })
    expect(await lib.countMentions(sam, 'all')).toBe(2)
    expect(await lib.countMentions(sam, 'snoozed')).toBe(1)
    // Set aside until later is not waiting on anybody.
    expect(await lib.openMentionCount(sam)).toBe(1)
    expect(await lib.openMentionCount(emma)).toBe(1)
  })

  // The Mentioned folder under a colleague's name on the rail asks a narrower
  // question than the rail's own: not everything Sam has ever been tagged in,
  // which would reach into addresses the reader has no business in, but the
  // asks on the ONE address they were let in to. The narrowing is a clause in
  // the SQL, so it is worth executing rather than reading.
  it('narrows an ask list to one address when the folder asks it to', async () => {
    const sales = (await lib.createInbox({
      name: 'Sales',
      address: 'sales@deskwell.co.uk',
    })).id
    const lead = await lib.createDiscussionThread({
      inboxId: sales,
      subject: 'A new enquiry',
      subjectNormalised: 'a new enquiry',
      preview: 'Somebody wants a quote',
      startedByUserId: emma,
      toUserIds: [sam],
    })
    await lib.upsertMention({
      threadId: lead, userId: sam, byUserId: emma, messageId: null, note: 'Yours, I think',
    })

    // Everything, wherever it sits - three now, across two addresses.
    expect(await lib.countMentions(sam, 'all')).toBe(3)

    const inSales = await lib.listMentions({
      userId: sam, status: 'all', page: 1, perPage: 25, inboxId: sales,
    })
    expect(inSales).toHaveLength(1)
    expect(inSales[0]).toMatchObject({ threadId: lead, inboxId: sales })

    expect(await lib.countMentions(sam, 'all', sales)).toBe(1)
    expect(await lib.countMentions(sam, 'all', accounts)).toBe(2)
    expect(await lib.mentionStatusCounts(sam, sales)).toEqual({
      open: 1, snoozed: 0, done: 0, all: 1,
    })

    // Emma has been asked about nothing in sales@, and asking about HER list
    // narrowed to it must not hand back Sam's.
    expect(await lib.listMentions({
      userId: emma, status: 'all', page: 1, perPage: 25, inboxId: sales,
    })).toEqual([])

    // Put the world back as the tests below expect to find it. The conversation
    // going takes the ask with it, which is the cascade two tests further down
    // relies on anyway.
    await db.$executeRawUnsafe(`DELETE FROM "uin_threads" WHERE "id" = $1`, lead)
    await db.$executeRawUnsafe(`DELETE FROM "uin_inboxes" WHERE "id" = $1`, sales)
  })

  it('refuses to let one colleague settle another’s ask', async () => {
    const sams = await lib.mentionForThread(sam, order)
    expect(await lib.setMentionStatus({
      id: sams!.id, userId: emma, status: 'done', until: null,
    })).toBe(false)
    // Untouched, which is the whole claim: the user id is in the WHERE clause
    // rather than in a check somebody could forget to write.
    expect((await lib.mentionForThread(sam, order))?.status).toBe('open')
  })

  it('brings back what was set aside once its time has passed', async () => {
    const second = await lib.mentionForThread(sam, query)
    await lib.setMentionStatus({
      id: second!.id,
      userId: sam,
      status: 'snoozed',
      until: new Date(Date.now() - 60 * 1000),
    })
    expect(await lib.wakeDueMentions()).toBe(1)
    expect((await lib.mentionForThread(sam, query))?.status).toBe('open')
    expect((await lib.mentionForThread(sam, query))?.snoozeUntil).toBeNull()
    // Nothing else is due, so a second sweep changes nothing.
    expect(await lib.wakeDueMentions()).toBe(0)
  })

  it('lets go of the ask when the conversation goes', async () => {
    await db.$executeRawUnsafe(`DELETE FROM "uin_threads" WHERE "id" = $1`, query)
    expect(await lib.mentionStatusCounts(sam)).toEqual({ open: 1, snoozed: 0, done: 0, all: 1 })
  })

  it('keeps the work when whoever asked for it leaves, and drops it when the asked-of does', async () => {
    await db.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, marcus)
    // Marcus asked Emma; Emma still has the job, with nobody's name on it.
    expect(await lib.mentionForThread(emma, order)).toMatchObject({ byUserId: null })

    await db.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, sam)
    expect(await lib.listMentions({ userId: sam, status: 'all', page: 1, perPage: 25 })).toEqual([])
    expect(await lib.hasMentionOn(order, sam)).toBe(false)
  })
})
