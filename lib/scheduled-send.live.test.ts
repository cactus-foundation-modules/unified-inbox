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

describe.runIf(shouldRun)('sending later, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: Db

  let purchasing = ''
  const emma = 'user-emma'

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
