import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
// Type only, and everything else that would reach the shared Prisma client is
// imported inside beforeAll: that client is built the first time it is imported
// and reads DATABASE_URL as it goes.
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
// Closing a discussion for yourself, executed (migrations/059).
//
// The per-person status is a CASE in the WHERE, the SELECT and the GROUP BY of
// every list, tab and count - raw SQL no typecheck, lint or build ever runs. So
// a real throwaway `cactus_rt_*` database on the Postgres VPS, dropped
// afterwards; the live site's database on the same server is never named,
// opened or altered. From the core checkout, with OVH_SERVER/OVH_USER/
// OVH_PASSWORD exported from the Deskwell workspace .env:
//
//   RUN_INBOX_DISCUSSIONS=1 npx vitest run \
//     modules/unified-inbox/lib/discussion-closures.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_DISCUSSIONS === '1'
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

const emma = 'user-emma'
const sam = 'user-sam'

describe.runIf(shouldRun)('closing a discussion for yourself against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: Db
  let bin: Bin
  let sales: string
  let discussion: string
  let email: string

  const filters = (viewerUserId: string, status: 'open' | 'done' | 'all') => ({
    viewerUserId,
    inboxIds: [sales],
    includeUnrouted: false,
    status,
    page: 1,
    perPage: 25,
  })
  const ids = async (viewer: string, status: 'open' | 'done') =>
    (await lib.listThreads(filters(viewer, status))).map((r) => r.id).sort()

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
    database = await createTestDatabase(vps, `cactus_rt_uinclose_${stamp}`, role)
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

    await db.$executeRawUnsafe(`INSERT INTO "Role" ("id", "name") VALUES ('role-staff', 'Staff')`)
    for (const [id, mail, username] of [[emma, 'emma@example.com', 'emma'], [sam, 'sam@example.com', 'sam']]) {
      await db.$executeRawUnsafe(
        `INSERT INTO "User" ("id", "email", "username", "roleId", "updatedAt") VALUES ($1, $2, $3, 'role-staff', now())`,
        id, mail, username,
      )
    }
    const rows = await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "uin_inboxes" ("name", "address") VALUES ('Sales', 'sales@example.com') RETURNING "id"`,
    )
    sales = rows[0]!.id

    discussion = await lib.createDiscussionThread({
      inboxId: sales,
      subject: 'Stock check',
      subjectNormalised: 'stock check',
      preview: 'Count the chairs',
      startedByUserId: emma,
      toUserIds: [sam],
    })
    email = await lib.createOutboundThread({ inboxId: sales, subject: 'Order', subjectNormalised: 'order', preview: null })
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('starts open for both of them', async () => {
    expect(await ids(emma, 'open')).toEqual([discussion, email].sort())
    expect(await ids(sam, 'open')).toEqual([discussion, email].sort())
  })

  it('closes for the one who closed it, and nobody else', async () => {
    await lib.closeDiscussionFor(discussion, emma)
    await lib.closeDiscussionFor(discussion, emma) // twice is still once

    expect(await ids(emma, 'open')).toEqual([email])
    expect(await ids(emma, 'done')).toEqual([discussion])
    expect((await lib.listThreads(filters(emma, 'done')))[0]!.status).toBe('done')
    expect(await ids(sam, 'open')).toEqual([discussion, email].sort())
    expect(await ids(sam, 'done')).toEqual([])
  })

  it('counts it the same way on the tabs and the rail', async () => {
    const emmaTabs = await lib.statusCounts(filters(emma, 'all'))
    const samTabs = await lib.statusCounts(filters(sam, 'all'))
    expect(emmaTabs.done).toBe(1)
    expect(emmaTabs.open).toBe(1)
    expect(samTabs.open).toBe(2)
    expect(samTabs.done ?? 0).toBe(0)
    expect(await lib.countThreads(filters(emma, 'open'))).toBe(1)

    const emmaRail = await lib.openCounts(emma, [sales], false)
    const samRail = await lib.openCounts(sam, [sales], false)
    expect(emmaRail[sales]).toBe(1)
    expect(samRail[sales]).toBe(2)
  })

  it('shows the open conversation as each reader sees it', async () => {
    expect((await lib.getThreadDetail(discussion, emma))?.status).toBe('done')
    expect((await lib.getThreadDetail(discussion, sam))?.status).toBe('open')
    // No reader named: the shared status, which is what the permission checks read.
    expect((await lib.getThreadDetail(discussion))?.status).toBe('open')
  })

  it('never lets a stray row close an email conversation', async () => {
    await db.$executeRawUnsafe(
      `INSERT INTO "uin_discussion_closures" ("thread_id", "user_id") VALUES ($1, $2)`, email, sam,
    )
    expect(await ids(sam, 'open')).toEqual([discussion, email].sort())
    await lib.reopenDiscussionFor(email, sam)
  })

  it('opens again for everybody, the writer included, when somebody writes in it', async () => {
    await lib.closeDiscussionFor(discussion, sam)
    await lib.reopenDiscussionForEveryone(discussion)
    expect(await ids(emma, 'open')).toEqual([discussion, email].sort())
    expect(await ids(sam, 'open')).toEqual([discussion, email].sort())
    expect(await ids(sam, 'done')).toEqual([])
  })

  it('opens for one person without touching anybody else', async () => {
    await lib.closeDiscussionFor(discussion, emma)
    await lib.closeDiscussionFor(discussion, sam)
    await lib.reopenDiscussionFor(discussion, sam)
    expect(await ids(sam, 'open')).toEqual([discussion, email].sort())
    expect(await ids(emma, 'done')).toEqual([discussion])
  })

  describe('deleting a discussion', () => {
    let samInbox: string
    let talk: string
    let samEmail: string
    // Emma covers Sam's post, so she sees his own address as well as sales@ -
    // the case where somebody else's bin used to hide things from her.
    const emmaView = (status: 'open' | 'all', extra: Record<string, unknown> = {}) => ({
      ...filters(emma, status), inboxIds: [sales, samInbox], ...extra,
    })
    const samView = (status: 'open' | 'all', extra: Record<string, unknown> = {}) => ({
      ...filters(sam, status), inboxIds: [sales, samInbox], ...extra,
    })
    const listIds = async (f: Parameters<Db['listThreads']>[0]) => (await lib.listThreads(f)).map((r) => r.id)

    it('goes into the presser\'s own bin, even from somebody else\'s address', async () => {
      const rows = await db.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO "uin_inboxes" ("name", "address", "kind", "owner_user_id")
         VALUES ('Sam', 'sam@example.com', 'individual', $1) RETURNING "id"`,
        sam,
      )
      samInbox = rows[0]!.id
      talk = await lib.createDiscussionThread({
        inboxId: samInbox, subject: 'Rota', subjectNormalised: 'rota', preview: 'Rota',
        startedByUserId: sam, toUserIds: [emma],
      })
      await lib.fileThreadInInboxes(talk, [samInbox, sales])
      samEmail = await lib.createOutboundThread({ inboxId: samInbox, subject: 'Quote', subjectNormalised: 'quote', preview: null })

      const inbox = { kind: 'individual', ownerUserId: sam }
      expect(bin.binOwnerForThread({ pressedByUserId: emma, inbox, channel: 'discussion' })).toBe(emma)
      // An email in Sam's own address still fills Sam's bin, exactly as before.
      expect(bin.binOwnerForThread({ pressedByUserId: emma, inbox, channel: 'email' })).toBe(sam)
    })

    it('hides it from the one who deleted it and nobody else', async () => {
      await bin.markThreadBinned(talk, sam)
      await bin.markThreadBinned(samEmail, sam)
      expect(await listIds(samView('open'))).not.toContain(talk)
      // Emma covers Sam's post: his deleted email is gone for her too, as it
      // always was, but the discussion is hers as much as his.
      expect(await listIds(emmaView('open'))).toContain(talk)
      expect(await listIds(emmaView('open'))).not.toContain(samEmail)
      expect(await listIds(samView('all', { binOnly: true }))).toEqual(expect.arrayContaining([talk, samEmail]))
    })

    it('empties out of their bin without destroying it for anybody else', async () => {
      const { destroy, purged } = await bin.purgeDiscussionsFromBin([talk, samEmail], sam)
      expect(destroy).toEqual([samEmail])
      expect(purged).toBe(1)
      // Twice is once.
      expect((await bin.purgeDiscussionsFromBin([talk], sam)).purged).toBe(0)

      expect(await listIds(samView('all', { binOnly: true }))).not.toContain(talk)
      expect(await listIds(samView('all'))).not.toContain(talk)
      expect(await listIds(emmaView('open'))).toContain(talk)
      expect(await lib.getThreadDetail(talk)).not.toBeNull()
    })
  })

  describe('asks on closed conversations', () => {
    const openAsks = async (who: string) =>
      (await lib.listMentions({ userId: who, status: 'open', page: 1, perPage: 50 })).map((r) => r.threadId)

    it('settles your own ask when you mark the conversation done, and nobody else\'s', async () => {
      await lib.upsertMention({ threadId: email, userId: emma, byUserId: sam, messageId: null, note: null })
      await lib.upsertMention({ threadId: email, userId: sam, byUserId: emma, messageId: null, note: null })
      expect(await lib.settleOwnMentionOn(email, emma)).toBe(1)
      expect(await lib.settleOwnMentionOn(email, emma)).toBe(0)
      expect(await openAsks(emma)).not.toContain(email)
      expect(await openAsks(sam)).toContain(email)
    })

    it('migration 060 settles asks left open on conversations already closed', async () => {
      await lib.upsertMention({ threadId: discussion, userId: emma, byUserId: sam, messageId: null, note: null })
      await lib.closeDiscussionFor(discussion, emma)
      await db.$executeRawUnsafe(`UPDATE "uin_threads" SET "status" = 'done' WHERE "id" = $1`, email)
      // Snoozed on purpose: must be left alone.
      await db.$executeRawUnsafe(
        `UPDATE "uin_mentions" SET "status" = 'snoozed', "snooze_until" = now() + interval '1 day' WHERE "thread_id" = $1 AND "user_id" = $2`,
        email, sam,
      )
      const { splitSqlStatements } = await import('@/lib/backup/restore')
      const file = readFileSync(path.join(MODULE_MIGRATIONS, '060_settle_asks_on_closed_conversations.sql'), 'utf8')
      for (const statement of splitSqlStatements(file)) await db.$executeRawUnsafe(statement)
      expect(await openAsks(emma)).not.toContain(discussion)
      const samRow = await db.$queryRawUnsafe<{ status: string }[]>(
        `SELECT "status" FROM "uin_mentions" WHERE "thread_id" = $1 AND "user_id" = $2`, email, sam,
      )
      expect(samRow[0]!.status).toBe('snoozed')
    })
  })
})
