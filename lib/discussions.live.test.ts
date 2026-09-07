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
// A discussion between colleagues, executed.
//
// `migrations/040_discussion_parties.sql` and the four helpers that read and
// write what it adds are raw SQL, and NOTHING else in this repository runs
// them: `tsc` sees a template string, `eslint` sees a template string, a build
// never executes a query, and the module build gate compiles rather than
// connects. A query Postgres will not parse is green everywhere until a
// customer opens the screen.
//
// Four claims are worth the network round trip, and each of them is a claim
// about the DATABASE rather than about the TypeScript:
//
//   1. The two new columns take what is written to them and come back through
//      the list's own query in the shapes the mapper expects - a TEXT[] cast
//      that Postgres refuses, or a column left off the SELECT, both read as
//      "nobody" rather than as an error.
//   2. A discussion put to a colleague LANDS IN THEIR POST: their address's
//      list has it and their unread tally counts it, which is the whole of what
//      was reported broken. It reaches them through the same table a merge
//      writes, so this also says the two uses of it do not tread on each other.
//   3. Only a colleague's OWN address is written to. A shared address somebody
//      merely reads is not their post, and a name that resolves to no address
//      is filed nowhere rather than somewhere convenient.
//   4. Merging a discussion and putting the merge back leaves it in the post of
//      everybody it was put to. `recomputeThreadInboxes` DELETES first, so
//      without its discussion branch an undo would quietly file it out of three
//      people's mailboxes and nothing on the screen would say so.
//   5. The back-fill at the foot of 040 reads a discussion that already exists -
//      its opening note's author, and the asks raised on that note - and is
//      idempotent, so a site that picks the file up twice is unharmed. This is
//      the one statement in the module that EDITS a customer's existing rows,
//      which makes it the one most worth executing before they do.
//
// A real throwaway database on the Postgres VPS, built from the core schema and
// this module's own migrations. Named `cactus_rt_*` and dropped afterwards; the
// live site's database sits on the same server and is never named, opened or
// altered.
//
// Skipped unless opted into, so a plain `npm test` never touches the network:
//
//   RUN_INBOX_DISCUSSIONS=1 npx vitest run \
//     modules/unified-inbox/lib/discussions.live.test.ts --testTimeout 120000
//
// A SKIP here is a FAIL - the whole point is that the SQL runs.
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

describe.runIf(shouldRun)('a discussion between colleagues, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let lib: Db
  let applyFile: (file: string) => Promise<void>

  let team = ''
  let emmaBox = ''
  let samBox = ''
  let marcusBox = ''

  const emma = 'user-emma'
  const marcus = 'user-marcus'
  const sam = 'user-sam'

  /** The list as one address sees it, which is the question the screen asks.
   *  Every list is now also a list as one PERSON sees it - "this is junk" is a
   *  reader's opinion rather than a fact about the mail (see
   *  migrations/041_spam.sql) - and nothing in this suite marks anything as
   *  junk, so any consistent reader will do. */
  const viewer = 'user-viewer'
  const listFor = async (inboxId: string) => await lib.listThreads({
    viewerUserId: viewer,
    inboxIds: [inboxId], includeUnrouted: false, inboxId, status: 'all', page: 1, perPage: 25,
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
    database = await createTestDatabase(vps, `cactus_rt_uindisc_${stamp}`, role)
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

    // Three real people: the foreign key from the conversation to "User" is
    // part of what is tested.
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

    team = (await lib.createInbox({ name: 'Sales', address: 'sales@deskwell.co.uk' })).id
    emmaBox = (await lib.createInbox({
      name: 'Emma', address: 'emma@deskwell.co.uk', kind: 'individual', ownerUserId: emma,
    })).id
    samBox = (await lib.createInbox({
      name: 'Sam', address: 'sam@deskwell.co.uk', kind: 'individual', ownerUserId: sam,
    })).id
    marcusBox = (await lib.createInbox({
      name: 'Marcus', address: 'marcus@deskwell.co.uk', kind: 'individual', ownerUserId: marcus,
    })).id
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('writes down who started it and who it was put to, and reads them back', async () => {
    const id = await lib.createDiscussionThread({
      inboxId: emmaBox,
      subject: 'The Henderson order',
      subjectNormalised: 'the henderson order',
      preview: 'A word about the Henderson order',
      startedByUserId: emma,
      toUserIds: [sam, marcus],
    })

    const [row] = await listFor(emmaBox)
    expect(row).toBeTruthy()
    expect(row!.id).toBe(id)
    expect(row!.channel).toBe('discussion')
    expect(row!.startedByUserId).toBe(emma)
    // In the order they were added, which is the order the To line reads in.
    expect(row!.toUserIds).toEqual([sam, marcus])
    // And the participant join still finds nothing, which is the point: every
    // message on a discussion is a note, and the row's sending end comes off
    // the conversation rather than out of that join.
    expect(row!.participantName).toBeNull()
    expect(row!.participantAddress).toBeNull()
  })

  it('reaches only a colleague\'s own address, never a shared one or a stranger', async () => {
    expect((await lib.ownInboxIdsForUsers([sam, marcus])).sort())
      .toEqual([marcusBox, samBox].sort())
    expect(await lib.ownInboxIdsForUsers([sam])).toEqual([samBox])
    // Sales is the team's, whoever reads it.
    expect(await lib.ownInboxIdsForUsers([sam])).not.toContain(team)
    // Somebody with no address of their own, and nobody at all.
    expect(await lib.ownInboxIdsForUsers(['user-nobody'])).toEqual([])
    expect(await lib.ownInboxIdsForUsers([])).toEqual([])
  })

  it('lands in the post of everybody it was put to, and counts there', async () => {
    const id = await lib.createDiscussionThread({
      inboxId: emmaBox,
      subject: 'Thursday deliveries',
      subjectNormalised: 'thursday deliveries',
      preview: 'Can one of you take Thursday',
      startedByUserId: emma,
      toUserIds: [sam, marcus],
    })
    await lib.fileThreadInInboxes(id, [emmaBox, ...await lib.ownInboxIdsForUsers([sam, marcus])])

    for (const inboxId of [emmaBox, samBox, marcusBox]) {
      const found = (await listFor(inboxId)).find((r) => r.id === id)
      expect(found, `discussion missing from ${inboxId}`).toBeTruthy()
      expect(found!.absorbedInboxIds.sort()).toEqual([emmaBox, marcusBox, samBox].sort())
    }

    // The tab badges agree with the lists behind them, which is a second query
    // reading the same table a different way.
    const counts = await lib.unreadCounts(viewer, [emmaBox, samBox, marcusBox, team], false)
    expect(counts[samBox]).toBeGreaterThanOrEqual(1)
    expect(counts[marcusBox]).toBeGreaterThanOrEqual(1)
    expect(counts[team] ?? 0).toBe(0)
  })

  it('files a discussion put to nobody in one address and writes no extra rows', async () => {
    const id = await lib.createDiscussionThread({
      inboxId: emmaBox,
      subject: 'A note to self',
      subjectNormalised: 'a note to self',
      preview: 'Remember the stock take',
      startedByUserId: emma,
      toUserIds: [],
    })
    await lib.fileThreadInInboxes(id, [emmaBox, ...await lib.ownInboxIdsForUsers([])])

    const found = (await listFor(emmaBox)).find((r) => r.id === id)
    expect(found!.toUserIds).toEqual([])
    // No rows at all: one address is what every conversation has, and rows here
    // would say the same thing at the cost of a join.
    expect(found!.absorbedInboxIds).toEqual([])
    expect((await listFor(samBox)).find((r) => r.id === id)).toBeUndefined()
  })

  it('keeps it in their post through a merge and back out again', async () => {
    const discussion = await lib.createDiscussionThread({
      inboxId: emmaBox,
      subject: 'The Peterson quote',
      subjectNormalised: 'the peterson quote',
      preview: 'Where did we get to on this',
      startedByUserId: emma,
      toUserIds: [sam],
    })
    await lib.fileThreadInInboxes(discussion, [emmaBox, ...await lib.ownInboxIdsForUsers([sam])])

    // Something in the team's address to fold into it. Created second, so the
    // discussion is the older of the two and therefore the one that wins.
    const other = await lib.createOutboundThread({
      inboxId: team,
      subject: 'The Peterson quote',
      subjectNormalised: 'the peterson quote',
      preview: 'Quote attached',
    })

    const merged = await lib.mergeThreads(discussion, [other], emma)
    expect(merged, JSON.stringify(merged)).not.toHaveProperty('error')
    const mergeId = (merged as { mergeIds: string[] }).mergeIds[0]!

    // Merged: Sam still has it, and so does the team's address now.
    expect((await listFor(samBox)).find((r) => r.id === discussion)).toBeTruthy()
    expect((await listFor(team)).find((r) => r.id === discussion)).toBeTruthy()

    const undone = await lib.undoThreadMerge(mergeId, emma)
    expect(undone, JSON.stringify(undone)).not.toHaveProperty('error')

    // Put back: the team's address lets go of it, and Sam does NOT. The undo
    // recomputes this list from nothing, so this is the assertion that says the
    // recompute knows a discussion has people on it.
    expect((await listFor(team)).find((r) => r.id === discussion)).toBeUndefined()
    const still = (await listFor(samBox)).find((r) => r.id === discussion)
    expect(still, 'the undo filed the discussion out of Sam\'s post').toBeTruthy()
    expect(still!.absorbedInboxIds.sort()).toEqual([emmaBox, samBox].sort())
  })

  it('reads a discussion that already existed, and reads it only once', async () => {
    // An old one, the way the module wrote them before 040: the conversation
    // knows where it sits and nothing about who it is between.
    const old = (await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "uin_threads"
         ("inbox_id", "channel", "subject", "subject_normalised", "preview",
          "last_message_at", "last_direction", "unread", "message_count")
       VALUES ($1, 'discussion', 'Before all this', 'before all this', 'From the old days',
               now(), 'note', true, 1)
       RETURNING "id"`,
      emmaBox,
    ))[0]!.id
    const opening = await lib.insertNote({
      threadId: old, channel: 'discussion', bodyHtml: 'Anyone?', bodyText: 'Anyone?',
      authorUserId: emma,
    })
    // A later note by somebody else, tagging a third person: neither may end up
    // on the To line, which is what makes this a test rather than a formality.
    const later = await lib.insertNote({
      threadId: old, channel: 'discussion', bodyHtml: 'Not me', bodyText: 'Not me',
      authorUserId: sam,
    })
    await lib.upsertMention({
      threadId: old, userId: sam, byUserId: emma, messageId: opening, note: 'Anyone?',
    })
    await lib.upsertMention({
      threadId: old, userId: marcus, byUserId: sam, messageId: later, note: 'Not me',
    })

    const before = (await listFor(emmaBox)).find((r) => r.id === old)
    expect(before!.startedByUserId).toBeNull()
    expect(before!.toUserIds).toEqual([])

    await applyFile(path.join(MODULE_MIGRATIONS, '040_discussion_parties.sql'))

    const filled = (await listFor(emmaBox)).find((r) => r.id === old)
    expect(filled!.startedByUserId).toBe(emma)
    // Sam was asked on the opening note. Marcus was asked on a later one and is
    // not on the To line, whatever else he is on.
    expect(filled!.toUserIds).toEqual([sam])
    // And it is in Sam's post now, filed under both addresses.
    expect(filled!.absorbedInboxIds.sort()).toEqual([emmaBox, samBox].sort())
    expect((await listFor(samBox)).find((r) => r.id === old)).toBeTruthy()

    // Twice does the work once: nothing is appended, nothing is overwritten.
    await applyFile(path.join(MODULE_MIGRATIONS, '040_discussion_parties.sql'))
    const again = (await listFor(emmaBox)).find((r) => r.id === old)
    expect(again!.startedByUserId).toBe(emma)
    expect(again!.toUserIds).toEqual([sam])
    expect(again!.absorbedInboxIds.sort()).toEqual([emmaBox, samBox].sort())
  })
})
