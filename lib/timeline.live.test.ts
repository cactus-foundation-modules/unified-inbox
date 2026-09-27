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
// The lines in a conversation, executed.
//
// Every statement behind them is raw SQL, and nothing else in this repository
// runs raw SQL: `tsc` and `eslint` see template strings, and a build never
// executes a query. Four of them are the sort only Postgres can judge:
//
//   - wakeDueThreads: a CTE that locks, an UPDATE that reads the pre-update
//     value through a join, and an INSERT fed from the UPDATE's RETURNING -
//     all in one statement, stamping the line with the time it was DUE.
//   - withdrawUndoneEvent: a DELETE ... USING a CTE with a jsonb containment
//     test, a millisecond interval sum and a correlated NOT EXISTS.
//   - holdScheduledDrafts: nullable parameters cast inside an OR, which is
//     where Prisma's untyped nulls and Postgres's type inference meet.
//   - setThreadBlocked: RETURNING a value read before the write.
//
// A real throwaway database on the Postgres VPS, built from the core schema and
// this module's own migrations. Named `cactus_rt_*` and dropped afterwards; the
// live site's database sits on the same server and is never named, opened or
// altered.
//
// Skipped unless opted into, so a plain `npm test` never touches the network:
//
//   RUN_INBOX_TIMELINE=1 npx vitest run \
//     modules/unified-inbox/lib/timeline.live.test.ts --testTimeout 120000
//
// with OVH_SERVER, OVH_USER and OVH_PASSWORD exported from the Deskwell
// workspace .env. A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_TIMELINE === '1'
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
type Bin = typeof import('./bin')
type Spam = typeof import('./spam')
type StandDown = typeof import('./stand-down')

const CHRIS = 'user-chris'
const SAM = 'user-sam'

describe.runIf(shouldRun)('the lines in a conversation, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: Db
  let bin: Bin
  let spam: Spam
  let standDown: StandDown
  let inboxId = ''

  const future = new Date(Date.now() + 86_400_000)

  const thread = async (subject = 'Two of the Artisan desks'): Promise<string> =>
    lib.createThread({
      inboxId,
      subject,
      subjectNormalised: subject.toLowerCase(),
      preview: null,
      lastMessageAt: new Date(),
      lastDirection: 'in',
      unread: true,
    })

  const eventsOn = async (threadId: string) =>
    db.$queryRaw<{ id: string; user_id: string | null; kind: string; detail: Record<string, unknown> | null; created_at: Date }[]>`
      SELECT "id", "user_id", "kind", "detail", "created_at" FROM "uin_events"
       WHERE "thread_id" = ${threadId} ORDER BY "created_at", "id"
    `

  const message = async (threadId: string, direction: 'in' | 'out' = 'in'): Promise<string> => {
    const rows = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO "uin_messages" ("thread_id", "direction") VALUES (${threadId}, ${direction}) RETURNING "id"
    `
    return rows[0]!.id
  }

  const scheduledReply = async (input: {
    author: string
    threadId: string | null
    to: string
    mode?: 'new' | 'reply' | 'reply-all' | 'forward'
  }) => lib.saveDraft({
    authorUserId: input.author,
    inboxId,
    threadId: input.threadId,
    mode: input.mode ?? (input.threadId ? 'reply' : 'new'),
    to: [input.to],
    cc: [],
    subject: 'Re: the desks',
    body: 'They are on their way.',
    attachments: [],
    sendAt: future,
  })

  const stateOf = async (draftId: string) => {
    const rows = await db.$queryRaw<{ send_state: string | null; held_by_thread_id: string | null }[]>`
      SELECT "send_state", "held_by_thread_id" FROM "uin_drafts" WHERE "id" = ${draftId}
    `
    return rows[0]
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
    database = await createTestDatabase(vps, `cactus_rt_uintl_${stamp}`, role)
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
    bin = await import('./bin')
    spam = await import('./spam')
    standDown = await import('./stand-down')

    await db.$executeRawUnsafe(`INSERT INTO "Role" ("id", "name") VALUES ('role-staff', 'Staff')`)
    for (const [id, name] of [[CHRIS, 'chris'], [SAM, 'sam']] as const) {
      await db.$executeRawUnsafe(
        `INSERT INTO "User" ("id", "email", "username", "roleId", "updatedAt")
         VALUES ($1, $2, $3, 'role-staff', now())`,
        id, `${name}@deskwell.co.uk`, name,
      )
    }

    const connection = await lib.createConnection({
      label: 'iCloud',
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapUsername: 'someone@example.com',
      imapPassword: 'nothing-real',
    })
    inboxId = (await lib.createInbox({
      name: 'Sales', address: 'sales@deskwell.co.uk', connectionId: connection.id,
    })).id
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  // -------------------------------------------------------------------------
  describe('a snooze running out', () => {
    it('wakes what is due, and stamps the line with when it was due', async () => {
      const due = await thread('Due')
      const later = await thread('Not yet')
      const dueAt = new Date(Date.now() - 3_600_000)
      await lib.setThreadStatus(due, 'snoozed', dueAt)
      await lib.setThreadStatus(later, 'snoozed', future)

      expect(await lib.wakeDueThreads()).toBeGreaterThanOrEqual(1)

      const woke = await eventsOn(due)
      expect(woke).toHaveLength(1)
      expect(woke[0]).toMatchObject({ user_id: null, kind: 'woken', detail: { was: 'snoozed', cause: 'time' } })
      // An hour ago, not now: that is when it ran out.
      expect(woke[0]!.created_at.getTime()).toBe(dueAt.getTime())
      expect(await eventsOn(later)).toEqual([])

      const rows = await db.$queryRaw<{ status: string; snooze_until: Date | null }[]>`
        SELECT "status", "snooze_until" FROM "uin_threads" WHERE "id" = ${due}
      `
      expect(rows[0]).toEqual({ status: 'open', snooze_until: null })
    })

    it('writes one line however many lists open at once', async () => {
      const due = await thread('Raced')
      await lib.setThreadStatus(due, 'snoozed', new Date(Date.now() - 60_000))
      await Promise.all([lib.wakeDueThreads(), lib.wakeDueThreads(), lib.wakeDueThreads()])
      expect(await eventsOn(due)).toHaveLength(1)
      expect(await lib.wakeDueThreads()).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  describe('taking a line back when its press is undone', () => {
    const binned = async (threadId: string, user = CHRIS, owner = CHRIS) =>
      lib.recordEvent(threadId, user, 'binned', { ownerUserId: owner })

    it('removes the newest line, by the same person, that matches', async () => {
      const id = await thread()
      await binned(id)
      expect(await lib.withdrawUndoneEvent({ threadId: id, userId: CHRIS, kinds: ['binned'], detailMatch: { ownerUserId: CHRIS } })).toBe(true)
      expect(await eventsOn(id)).toEqual([])
    })

    it('leaves somebody else\'s line alone', async () => {
      const id = await thread()
      await binned(id, SAM, SAM)
      expect(await lib.withdrawUndoneEvent({ threadId: id, userId: CHRIS, kinds: ['binned'], detailMatch: { ownerUserId: SAM } })).toBe(false)
      expect(await eventsOn(id)).toHaveLength(1)
    })

    it('leaves a line whose detail says it was something else', async () => {
      const id = await thread()
      await binned(id, CHRIS, SAM)
      expect(await lib.withdrawUndoneEvent({ threadId: id, userId: CHRIS, kinds: ['binned'], detailMatch: { ownerUserId: CHRIS } })).toBe(false)
    })

    it('leaves it once a message has arrived since', async () => {
      const id = await thread()
      await binned(id)
      await new Promise((r) => setTimeout(r, 20))
      await message(id)
      expect(await lib.withdrawUndoneEvent({ threadId: id, userId: CHRIS, kinds: ['binned'], detailMatch: { ownerUserId: CHRIS } })).toBe(false)
    })

    it('leaves it when something else has happened since', async () => {
      const id = await thread()
      await binned(id)
      await new Promise((r) => setTimeout(r, 20))
      await lib.recordEvent(id, SAM, 'assigned', { to: SAM })
      expect(await lib.withdrawUndoneEvent({ threadId: id, userId: CHRIS, kinds: ['binned'], detailMatch: { ownerUserId: CHRIS } })).toBe(false)
    })

    it('leaves it once the moment has passed', async () => {
      const id = await thread()
      await binned(id)
      await db.$executeRaw`UPDATE "uin_events" SET "created_at" = "created_at" - interval '5 minutes' WHERE "thread_id" = ${id}`
      expect(await lib.withdrawUndoneEvent({ threadId: id, userId: CHRIS, kinds: ['binned'], detailMatch: { ownerUserId: CHRIS } })).toBe(false)
    })

    it('matches a status line on where it was before', async () => {
      const id = await thread()
      await lib.recordEvent(id, CHRIS, 'snoozed', { status: 'snoozed', until: future.toISOString(), was: 'open', wasUntil: null })
      expect(await lib.withdrawUndoneEvent({ threadId: id, userId: CHRIS, kinds: ['status', 'snoozed'], detailMatch: { was: 'done' } })).toBe(false)
      expect(await lib.withdrawUndoneEvent({ threadId: id, userId: CHRIS, kinds: ['status', 'snoozed'], detailMatch: { was: 'open' } })).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  describe('standing scheduled messages down', () => {
    it('stands down a reply on the conversation whoever it was addressed to', async () => {
      const id = await thread()
      const waiting = await scheduledReply({ author: CHRIS, threadId: id, to: 'ada@example.com' })
      // Somebody Cc'd on it answers from an address the reply was never going to.
      const held = await lib.holdScheduledDrafts({ threadId: id, address: 'colleague.of.ada@example.com', sameThread: true, exceptAuthorUserId: null })
      expect(held.map((d) => d.id)).toEqual([waiting.id])
      expect(await stateOf(waiting.id)).toEqual({ send_state: null, held_by_thread_id: id })
    })

    it('leaves a forward on the conversation alone', async () => {
      const id = await thread()
      const forward = await scheduledReply({ author: CHRIS, threadId: id, to: 'supplier@example.com', mode: 'forward' })
      expect(await lib.holdScheduledDrafts({ threadId: id, address: null, sameThread: true, exceptAuthorUserId: null })).toEqual([])
      expect((await stateOf(forward.id))?.send_state).toBe('scheduled')
    })

    it('spares the colleague who answered, and nobody else', async () => {
      const id = await thread()
      const chris = await scheduledReply({ author: CHRIS, threadId: id, to: 'ada@example.com' })
      const sam = await scheduledReply({ author: SAM, threadId: id, to: 'ada@example.com' })
      const held = await lib.holdScheduledDrafts({ threadId: id, address: null, sameThread: true, exceptAuthorUserId: SAM })
      expect(held.map((d) => d.id)).toEqual([chris.id])
      expect((await stateOf(sam.id))?.send_state).toBe('scheduled')
    })

    it('matches by address on other conversations only when asked to', async () => {
      const here = await thread()
      const elsewhere = await scheduledReply({ author: CHRIS, threadId: null, to: 'Grace@Example.com' })
      expect(await lib.holdScheduledDrafts({ threadId: here, address: null, sameThread: true, exceptAuthorUserId: null })).toEqual([])
      const held = await lib.holdScheduledDrafts({ threadId: here, address: 'grace@example.com', sameThread: true, exceptAuthorUserId: null })
      expect(held.map((d) => d.id)).toEqual([elsewhere.id])
    })

    it('asks nothing when it has nothing to match on', async () => {
      const id = await thread()
      await scheduledReply({ author: CHRIS, threadId: id, to: 'ada@example.com' })
      expect(await lib.holdScheduledDrafts({ threadId: id, address: null, sameThread: false, exceptAuthorUserId: null })).toEqual([])
    })

    it('writes the lines on the conversation it landed on and on each other one', async () => {
      const arriving = await thread('Arriving')
      const other = await thread('Other')
      // An address nothing earlier in this file wrote to: every scheduled
      // message to Ada still waiting from the tests above would be stood down
      // too, which is the rule working rather than this test.
      const here = await scheduledReply({ author: CHRIS, threadId: arriving, to: 'hazel@example.com' })
      const there = await scheduledReply({ author: SAM, threadId: other, to: 'hazel@example.com' })
      const messageId = await message(arriving)

      const held = await standDown.standDownScheduled({ threadId: arriving, messageId, direction: 'in', fromAddress: 'HAZEL@example.com', senderUserId: null })
      expect(held.map((d) => d.id).sort()).toEqual([here.id, there.id].sort())

      const onArriving = await eventsOn(arriving)
      expect(onArriving).toHaveLength(1)
      expect(onArriving[0]).toMatchObject({ user_id: null, kind: 'held', detail: { cause: 'they', count: 2, messageId } })
      const onOther = await eventsOn(other)
      expect(onOther).toHaveLength(1)
      expect(onOther[0]).toMatchObject({ kind: 'held', detail: { cause: 'they', count: 1, elsewhereThreadId: arriving, draftIds: [there.id] } })

      // And the warning over the arriving conversation finds this reader's own.
      expect((await lib.draftsHeldByThread(arriving, CHRIS)).map((d) => d.id)).toContain(here.id)
    })
  })

  // -------------------------------------------------------------------------
  describe('saying only when something moved', () => {
    it('reports the first blocked stamp and not the second', async () => {
      const id = await thread()
      expect(await lib.setThreadBlocked(id, true)).toBe(true)
      expect(await lib.setThreadBlocked(id, true)).toBe(false)
      expect(await lib.setThreadBlocked(id, false)).toBe(true)
      expect(await lib.setThreadBlocked(id, false)).toBe(false)
    })

    it('reports a bin and a junk mark going in and coming out once each', async () => {
      const id = await thread()
      expect(await bin.markThreadBinned(id, CHRIS)).toBe(true)
      expect(await bin.markThreadBinned(id, CHRIS)).toBe(false)
      expect(await bin.unmarkThreadBinned(id, CHRIS)).toBe(true)
      expect(await bin.unmarkThreadBinned(id, CHRIS)).toBe(false)
      expect(await spam.markThreadSpam(id, SAM)).toBe(true)
      expect(await spam.markThreadSpam(id, SAM)).toBe(false)
      expect(await spam.unmarkThreadSpam(id, SAM)).toBe(true)
      expect(await spam.unmarkThreadSpam(id, SAM)).toBe(false)
    })

    it('hands back when each message was collected, for placing lines', async () => {
      const id = await thread()
      await message(id)
      const [row] = await lib.listThreadMessages(id)
      expect(row?.createdAt).toBeInstanceOf(Date)
    })
  })
})
