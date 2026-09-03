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
// Messages written now and sent later, executed.
//
// `migrations/021_scheduled_send.sql` and the four statements that queue, claim,
// fail and release one are raw SQL, and nothing else in this repository runs
// them: `tsc` sees a template string, `eslint` sees a template string, and a
// build never executes a query. Two of them are the sort that only Postgres can
// judge - an UPDATE whose row list comes from a subquery with FOR UPDATE SKIP
// LOCKED, and a saveDraft whose SET clause is assembled out of two different
// SQL fragments depending on whether a time was mentioned at all.
//
// The claim is the one worth executing rather than reasoning about. It is what
// stops one message being emailed twice, and "the second caller gets no rows"
// is a claim about Postgres, not about TypeScript.
//
// A real throwaway database on the Postgres VPS, built from the core schema and
// this module's own migrations. Named `cactus_rt_*` and dropped afterwards; the
// live site's database sits on the same server and is never named, opened or
// altered.
//
// Skipped unless opted into, so a plain `npm test` never touches the network:
//
//   RUN_INBOX_SCHEDULE_GUARDS=1 npx vitest run \
//     modules/unified-inbox/lib/scheduled-send.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_SCHEDULE_GUARDS === '1'
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
type FollowUp = typeof import('./follow-up')

describe.runIf(shouldRun)('sending later, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: Db
  let followUp: FollowUp

  let purchasing = ''
  const emma = 'user-emma'
  // Somebody else on the same address, who can finish and send Emma's
  // half-written messages - which is the whole reason the chase has to know
  // whose message it was.
  const marcus = 'user-marcus'

  const past = new Date('2026-01-01T09:00:00.000Z')
  const future = new Date(Date.now() + 86_400_000)

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
    database = await createTestDatabase(vps, `cactus_rt_uinsch_${stamp}`, role)
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
    followUp = await import('./follow-up')

    await db.$executeRawUnsafe(`INSERT INTO "Role" ("id", "name") VALUES ('role-staff', 'Staff')`)
    await db.$executeRawUnsafe(
      `INSERT INTO "User" ("id", "email", "username", "roleId", "updatedAt")
       VALUES ($1, 'emma@deskwell.co.uk', 'emma', 'role-staff', now())`,
      emma,
    )

    await db.$executeRawUnsafe(
      `INSERT INTO "User" ("id", "email", "username", "roleId", "updatedAt")
       VALUES ($1, 'marcus@deskwell.co.uk', 'marcus', 'role-staff', now())`,
      marcus,
    )

    const connection = await lib.createConnection({
      label: 'iCloud',
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapUsername: 'someone@example.com',
      imapPassword: 'nothing-real',
    })
    purchasing = (await lib.createInbox({
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

  /** A message starting a conversation, with or without a time on it. */
  async function put(sendAt: Date | null | undefined, body = 'The order, as discussed.') {
    return await lib.saveDraft({
      authorUserId: emma,
      replyableInboxIds: [purchasing],
      inboxId: purchasing,
      threadId: null,
      mode: 'new',
      to: ['supplier@example.com'],
      cc: [],
      subject: 'Our order',
      body,
      attachments: [],
      sendAt,
    })
  }

  it('leaves an ordinary draft with no time and no state', async () => {
    const draft = await put(undefined)
    expect(draft.sendAt).toBeNull()
    expect(draft.sendState).toBeNull()
    await lib.deleteDraft(draft.id, emma, [purchasing])
  })

  it('puts a time on one, and reads it back', async () => {
    const draft = await put(future)
    expect(draft.sendState).toBe('scheduled')
    expect(draft.sendAt?.toISOString()).toBe(future.toISOString())

    const again = await lib.getDraft(draft.id, emma, [purchasing])
    expect(again?.sendState).toBe('scheduled')
    await lib.deleteDraft(draft.id, emma, [purchasing])
  })

  it('keeps the time when a save says nothing about it, and drops it when a save says null', async () => {
    // The whole reason saveDraft assembles its SET clause out of two fragments:
    // pressing Save as a draft on a message set for the morning must not
    // quietly cancel the morning.
    const draft = await put(future)
    const saved = await lib.saveDraft({
      id: draft.id,
      authorUserId: emma,
      replyableInboxIds: [purchasing],
      inboxId: purchasing,
      threadId: null,
      mode: 'new',
      to: ['supplier@example.com'],
      cc: [],
      subject: 'Our order',
      body: 'Second thoughts, same time.',
      attachments: [],
    })
    expect(saved.id).toBe(draft.id)
    expect(saved.sendState).toBe('scheduled')
    expect(saved.sendAt?.toISOString()).toBe(future.toISOString())

    const cancelled = await lib.saveDraft({
      id: draft.id,
      authorUserId: emma,
      replyableInboxIds: [purchasing],
      inboxId: purchasing,
      threadId: null,
      mode: 'new',
      to: ['supplier@example.com'],
      cc: [],
      subject: 'Our order',
      body: 'Second thoughts, no time.',
      attachments: [],
      sendAt: null,
    })
    expect(cancelled.sendAt).toBeNull()
    expect(cancelled.sendState).toBeNull()
    await lib.deleteDraft(draft.id, emma, [purchasing])
  })

  it('claims only what is due, and only once', async () => {
    const due = await put(past, 'Due already.')
    const later = await put(future, 'Not yet.')

    const first = await lib.claimDueScheduledDrafts(new Date(), 10)
    expect(first.map((d) => d.id)).toEqual([due.id])
    expect(first[0]!.sendState).toBe('sending')

    // The second run over the same queue finds nothing: the claim moved the row
    // out of 'scheduled' in the same statement that found it. This is the whole
    // guard against one message being emailed twice.
    const second = await lib.claimDueScheduledDrafts(new Date(), 10)
    expect(second).toEqual([])

    await lib.deleteDraft(due.id, emma, [purchasing])
    await lib.deleteDraft(later.id, emma, [purchasing])
  })

  it('writes the reason on one that could not be sent, and keeps the writing', async () => {
    const draft = await put(past, 'This one will be refused.')
    await lib.claimDueScheduledDrafts(new Date(), 10)
    await lib.failScheduledDraft(draft.id, 'That inbox has no way to send mail yet.')

    const after = await lib.getDraft(draft.id, emma, [purchasing])
    expect(after?.sendState).toBe('failed')
    expect(after?.sendError).toBe('That inbox has no way to send mail yet.')
    expect(after?.body).toBe('This one will be refused.')
    // A failed one is not picked up again on its own - somebody has to look at
    // it, which is the point of saying so.
    expect(await lib.claimDueScheduledDrafts(new Date(), 10)).toEqual([])
    await lib.deleteDraft(draft.id, emma, [purchasing])
  })

  it('puts back a claim from a run that died, and leaves a fresh one alone', async () => {
    const draft = await put(past, 'Taken by a run that fell over.')
    await lib.claimDueScheduledDrafts(new Date(), 10)

    // A fresh claim is somebody else's work in flight.
    expect(await lib.releaseStaleScheduledClaims(new Date(Date.now() - 600_000))).toBe(0)
    expect((await lib.getDraft(draft.id, emma, [purchasing]))?.sendState).toBe('sending')

    expect(await lib.releaseStaleScheduledClaims(new Date(Date.now() + 1000))).toBe(1)
    const back = await lib.getDraft(draft.id, emma, [purchasing])
    expect(back?.sendState).toBe('scheduled')
    // And it is due again, which is what "put back" has to mean.
    expect((await lib.claimDueScheduledDrafts(new Date(), 10)).map((d) => d.id)).toEqual([draft.id])
    await lib.deleteDraft(draft.id, emma, [purchasing])
  })

  it('puts back exactly the rows a run named, and no others', async () => {
    // What the deadline path does. Releasing by age there would disturb a claim
    // another run is still working through, so it releases by id instead.
    const mine = await put(past, 'Claimed and not reached.')
    const theirs = await put(past, 'Somebody else is sending this one.')
    const claimed = await lib.claimDueScheduledDrafts(new Date(), 10)
    expect(claimed).toHaveLength(2)

    expect(await lib.releaseScheduledClaims([mine.id])).toBe(1)
    expect((await lib.getDraft(mine.id, emma, [purchasing]))?.sendState).toBe('scheduled')
    expect((await lib.getDraft(theirs.id, emma, [purchasing]))?.sendState).toBe('sending')

    expect(await lib.releaseScheduledClaims([])).toBe(0)
    await lib.deleteDraft(mine.id, emma, [purchasing])
    await lib.deleteDraft(theirs.id, emma, [purchasing])
  })

  it('keeps a follow-up with the time, and drops it when the time comes off', async () => {
    // The follow-up rides with the departure time. A save that says nothing
    // about the time says nothing about the chase either; cancelling the timer
    // cancels the chase, because a message that is not going anywhere has
    // nothing to be chased about.
    const draft = await lib.saveDraft({
      authorUserId: emma,
      replyableInboxIds: [purchasing],
      inboxId: purchasing,
      threadId: null,
      mode: 'new',
      to: ['supplier@example.com'],
      cc: [],
      subject: 'Our order',
      body: 'Chase this one.',
      attachments: [],
      sendAt: future,
      followUpMinutes: 4320,
    })
    expect(draft.followUpMinutes).toBe(4320)

    const untouched = await lib.saveDraft({
      id: draft.id,
      authorUserId: emma,
      replyableInboxIds: [purchasing],
      inboxId: purchasing,
      threadId: null,
      mode: 'new',
      to: ['supplier@example.com'],
      cc: [],
      subject: 'Our order',
      body: 'Same time, same chase.',
      attachments: [],
    })
    expect(untouched.followUpMinutes).toBe(4320)

    const cancelled = await lib.saveDraft({
      id: draft.id,
      authorUserId: emma,
      replyableInboxIds: [purchasing],
      inboxId: purchasing,
      threadId: null,
      mode: 'new',
      to: ['supplier@example.com'],
      cc: [],
      subject: 'Our order',
      body: 'No time, no chase.',
      attachments: [],
      sendAt: null,
    })
    expect(cancelled.followUpMinutes).toBeNull()
    await lib.deleteDraft(draft.id, emma, [purchasing])
  })

  it('takes a chase measured in hours, and refuses one measured in a minute', async () => {
    // Migration 023 dropped the day-long floor: the follow-up offers the same
    // answers snoozing does, and "in three hours" is three hours.
    const draft = await put(future)
    await db.$executeRawUnsafe(`UPDATE "uin_drafts" SET "follow_up_minutes" = 180 WHERE "id" = $1`, draft.id)
    expect((await lib.getDraft(draft.id, emma, [purchasing]))?.followUpMinutes).toBe(180)

    await expect(
      db.$executeRawUnsafe(`UPDATE "uin_drafts" SET "follow_up_minutes" = 1 WHERE "id" = $1`, draft.id),
    ).rejects.toThrow()
    await lib.deleteDraft(draft.id, emma, [purchasing])
  })

  it('stands a scheduled message down when they write first, and keeps the writing', async () => {
    const thread = await lib.createThread({
      inboxId: purchasing,
      subject: 'Our order',
      subjectNormalised: 'our order',
      preview: 'About that order',
      lastMessageAt: new Date(),
      lastDirection: 'in',
      unread: true,
    })
    // Addressed in a different case from the one the mail arrived in, which is
    // the ordinary case rather than the awkward one: nobody types an address
    // the same way twice.
    const waiting = await lib.saveDraft({
      authorUserId: emma,
      replyableInboxIds: [purchasing],
      inboxId: purchasing,
      threadId: null,
      mode: 'new',
      to: ['Supplier@Example.com'],
      cc: [],
      subject: 'Our order',
      body: 'Any news on the delivery?',
      attachments: [],
      sendAt: future,
    })

    const held = await lib.holdScheduledDraftsFor('supplier@example.com', thread)
    expect(held.map((d) => d.id)).toEqual([waiting.id])

    const after = await lib.getDraft(waiting.id, emma, [purchasing])
    expect(after?.sendState).toBeNull()
    expect(after?.heldByThreadId).toBe(thread)
    expect(after?.heldAt).toBeInstanceOf(Date)
    // The time it was set for is kept, so the screen can say what it was going
    // to do rather than only that it is not doing it.
    expect(after?.sendAt?.toISOString()).toBe(future.toISOString())
    expect(after?.body).toBe('Any news on the delivery?')
    // And nothing collects it any more, which is the whole point.
    expect(await lib.claimDueScheduledDrafts(new Date(Date.now() + 172_800_000), 10)).toEqual([])

    const warned = await lib.draftsHeldByThread(thread, emma, [purchasing])
    expect(warned.map((d) => d.id)).toEqual([waiting.id])

    await lib.deleteDraft(waiting.id, emma, [purchasing])
  })

  it('leaves a message that is already going out alone', async () => {
    // The mail server may already have it. Standing it down would be the module
    // telling somebody a message it had sent was still here.
    const going = await put(past, 'Already on its way.')
    await lib.claimDueScheduledDrafts(new Date(), 10)
    expect(await lib.holdScheduledDraftsFor('supplier@example.com', 'no-such-thread')).toEqual([])
    expect((await lib.getDraft(going.id, emma, [purchasing]))?.sendState).toBe('sending')
    await lib.deleteDraft(going.id, emma, [purchasing])
  })

  it('leaves a scheduled message to somebody else alone', async () => {
    const mine = await put(future, 'This one is for the supplier.')
    expect(await lib.holdScheduledDraftsFor('someone.else@example.com', 'no-such-thread')).toEqual([])
    expect((await lib.getDraft(mine.id, emma, [purchasing]))?.sendState).toBe('scheduled')
    await lib.deleteDraft(mine.id, emma, [purchasing])
  })

  it('puts a message that was held back in the queue when it is scheduled again', async () => {
    const thread = await lib.createThread({
      inboxId: purchasing,
      subject: 'Second thoughts',
      subjectNormalised: 'second thoughts',
      preview: null,
      lastMessageAt: new Date(),
      lastDirection: 'in',
      unread: true,
    })
    const waiting = await put(future, 'Held, then sent anyway.')
    await lib.holdScheduledDraftsFor('supplier@example.com', thread)

    const again = await lib.saveDraft({
      id: waiting.id,
      authorUserId: emma,
      replyableInboxIds: [purchasing],
      inboxId: purchasing,
      threadId: null,
      mode: 'new',
      to: ['supplier@example.com'],
      cc: [],
      subject: 'Our order',
      body: 'Read what they said, sending it anyway.',
      attachments: [],
      sendAt: future,
    })
    expect(again.sendState).toBe('scheduled')
    expect(again.heldByThreadId).toBeNull()
    expect(await lib.draftsHeldByThread(thread, emma, [purchasing])).toEqual([])
    await lib.deleteDraft(waiting.id, emma, [purchasing])
  })

  it('hands the chase to whoever wrote the message, not to whoever sent it', async () => {
    // A shared address means Marcus can finish and send what Emma started. The
    // person waiting on an answer is the one who asked the question, so the
    // conversation comes back to her.
    const thread = await lib.createThread({
      inboxId: purchasing,
      subject: 'Our order',
      subjectNormalised: 'our order',
      preview: null,
      lastMessageAt: new Date(),
      lastDirection: 'out',
      unread: false,
    })
    await lib.assignThread(thread, marcus)

    const sentAt = new Date('2026-06-02T09:07:00.000Z')
    await followUp.applyFollowUpAfterSend(
      { authorUserId: emma, followUpMinutes: 60 * 24 * 3 },
      thread,
      sentAt,
    )

    const after = await lib.getThreadDetail(thread)
    expect(after?.status).toBe('snoozed')
    expect(after?.snoozeUntil?.toISOString()).toBe('2026-06-05T09:07:00.000Z')
    expect(after?.assigneeUserId).toBe(emma)

    const events = await lib.listThreadEvents(thread)
    const chase = events.find((event) => event.kind === 'awaiting')
    expect(chase?.detail).toMatchObject({ minutes: 4320, userId: emma })
  })

  it('does nothing at all to a message written without a chase on it', async () => {
    const thread = await lib.createThread({
      inboxId: purchasing,
      subject: 'No chase',
      subjectNormalised: 'no chase',
      preview: null,
      lastMessageAt: new Date(),
      lastDirection: 'out',
      unread: false,
    })
    await followUp.applyFollowUpAfterSend({ authorUserId: emma, followUpMinutes: null }, thread, new Date())
    const after = await lib.getThreadDetail(thread)
    expect(after?.status).toBe('open')
    expect(after?.assigneeUserId).toBeNull()
  })

  it('hands back what it deleted, so a chase outlives the draft that carried it', async () => {
    const draft = await lib.saveDraft({
      authorUserId: emma,
      replyableInboxIds: [purchasing],
      inboxId: purchasing,
      threadId: null,
      mode: 'new',
      to: ['supplier@example.com'],
      cc: [],
      subject: 'Our order',
      body: 'Sent by Marcus, written by Emma.',
      attachments: [],
      sendAt: future,
      followUpMinutes: 4320,
    })
    // Marcus tidies it away after pressing Send, and what comes back still
    // carries Emma's name and her chase.
    const gone = await lib.deleteDraftReturning(draft.id, marcus, [purchasing])
    expect(gone?.authorUserId).toBe(emma)
    expect(gone?.followUpMinutes).toBe(4320)
    expect(await lib.deleteDraftReturning(draft.id, marcus, [purchasing])).toBeNull()
  })

  it('refuses a state the queue does not know', async () => {
    const draft = await put(future)
    await expect(
      db.$executeRawUnsafe(`UPDATE "uin_drafts" SET "send_state" = 'posted' WHERE "id" = $1`, draft.id),
    ).rejects.toThrow()
    await lib.deleteDraft(draft.id, emma, [purchasing])
  })

  it('refuses a state with no time to go with it', async () => {
    const draft = await put(future)
    await expect(
      db.$executeRawUnsafe(`UPDATE "uin_drafts" SET "send_at" = NULL WHERE "id" = $1`, draft.id),
    ).rejects.toThrow()
    await lib.deleteDraft(draft.id, emma, [purchasing])
  })
})
