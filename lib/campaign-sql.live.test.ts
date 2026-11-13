import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
// Type only, and the campaign store is imported inside beforeAll: the shared
// Prisma client is built the first time it is imported and reads DATABASE_URL
// as it goes.
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
// The campaign queries, executed.
//
// Every one of these is raw SQL and nothing else in this repository runs it:
// tsc sees a template string, eslint sees a template string, and a build never
// executes a query. Three things here would sail through every other gate and
// then be wrong in front of a customer.
//
// A NEW CAMPAIGN'S CLOCK. It is written out column by column rather than left
// to the table's own defaults, so that a fresh campaign opens with every When
// box empty. Midnight to midnight has to satisfy the window CHECK, which is
// written as start < end with end <= 1440 - one off in either direction and
// creating a campaign fails outright.
//
// AIMING A CLAIM. `claimRecipient` takes one named person out of the queue
// instead of whoever is next. If its WHERE ever stops insisting on 'queued',
// two people pressing Send now send the same email twice, and the person who
// gets it twice unsubscribes.
//
// TAKING THE LANE EARLY. `claimLaneNow` is the same claim as the runner's with
// the "has the clock come round" half removed, because Send now exists to skip
// the wait. What it must NOT skip is one-at-a-time - and a live claim held by a
// run has to still turn it away.
//
// Skipped unless opted into, so a plain `npm test` never touches the network:
//
//   RUN_INBOX_CAMPAIGN_SQL=1 npx vitest run \
//     modules/unified-inbox/lib/campaign-sql.live.test.ts --testTimeout 120000
//
// A SKIP HERE IS A FAIL - the whole point is that the SQL runs.
// ---------------------------------------------------------------------------

const shouldRun = process.env.RUN_INBOX_CAMPAIGN_SQL === '1'
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

type Store = typeof import('./campaigns/store')
type Consent = typeof import('./campaigns/consent')

describe.runIf(shouldRun)('the campaign queries, against a real database', () => {
  let vps: VpsConfig
  let role: TestRole
  let database: TestDatabase
  let db: ExtendedPrismaClient
  let store: Store
  let consent: Consent
  let inboxId: string

  beforeAll(async () => {
    if (!process.env.OVH_SERVER || !process.env.OVH_USER
      || (!process.env.OVH_PASSWORD && !process.env.OVH_SSH_KEY)) {
      throw new Error(
        'OVH_SERVER, OVH_USER and OVH_SSH_KEY (or OVH_PASSWORD) are needed for this suite. '
        + 'See ~/bin/cactus-db-gates.sh for the values - a skip here is a fail.',
      )
    }
    vps = vpsConfigFromEnv()
    await dropStaleTestObjects(vps)

    const stamp = Date.now()
    role = await createTestRole(vps, `cactus_rt_role_${stamp}`)
    database = await createTestDatabase(vps, `cactus_rt_uincamp_${stamp}`, role)
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

    // A mailbox for the lane to belong to. The lane keys off it by foreign key,
    // so a made-up id would fail for the wrong reason.
    const inbox = await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "uin_inboxes" ("name", "address") VALUES ('Sales', 'sales@example.co.uk') RETURNING "id"`,
    )
    inboxId = inbox[0]!.id

    store = await import('./campaigns/store')
    consent = await import('./campaigns/consent')
  }, 600_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (!vps) return
    if (database) await dropTestDatabase(vps, database.name).catch(() => {})
    if (role) await dropTestRole(vps, role.name).catch(() => {})
    await dropStaleTestObjects(vps).catch(() => {})
  }, 600_000)

  it('opens a new campaign with every When box empty, and the CHECK allows it', async () => {
    const id = await store.createCampaign({ name: 'September chairs', inboxId, createdBy: 'tester' })
    const campaign = await store.getCampaign(id)
    expect(campaign).not.toBeNull()
    expect(campaign!.window).toMatchObject({
      startMinute: 0,
      endMinute: 1440,
      weekdaysOnly: false,
      dailyCap: null,
      rampEnabled: false,
    })
  })

  it('refuses a window whose end is not after its start', async () => {
    // The claim the constraint makes. Nothing else runs it, and a window that
    // sends nothing for ever would otherwise sit in the column silently.
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "uin_campaigns" SET "window_start_minute" = 600, "window_end_minute" = 600`,
      ),
    ).rejects.toThrow()
  })

  it('claims one named person, and only while they are still waiting', async () => {
    const id = await store.createCampaign({ name: 'Send now', inboxId, createdBy: 'tester' })
    await store.insertRecipients(
      id,
      [
        seed('one@example.co.uk'),
        seed('two@example.co.uk'),
      ],
      new Date(),
    )

    const { rows } = await store.listRecipients(id, { state: null, search: null, page: 1, perPage: 50 })
    const target = rows.find((r) => r.address === 'two@example.co.uk')!

    const claimed = await store.claimRecipient(id, target.id, new Date())
    expect(claimed?.address).toBe('two@example.co.uk')
    expect(claimed?.state).toBe('sending')

    // The second press. One send, one polite refusal - never two emails.
    expect(await store.claimRecipient(id, target.id, new Date())).toBeNull()

    // And the other one is untouched: aiming a claim must not take whoever is
    // next as a consolation prize.
    const after = await store.campaignTally(id)
    expect(after.queued).toBe(1)
    expect(after.sending).toBe(1)
  })

  it('will not claim somebody on a different campaign', async () => {
    const mine = await store.createCampaign({ name: 'Mine', inboxId, createdBy: 'tester' })
    const theirs = await store.createCampaign({ name: 'Theirs', inboxId, createdBy: 'tester' })
    await store.insertRecipients(theirs, [seed('elsewhere@example.co.uk')], new Date())
    const { rows } = await store.listRecipients(theirs, { state: null, search: null, page: 1, perPage: 50 })

    expect(await store.claimRecipient(mine, rows[0]!.id, new Date())).toBeNull()
  })

  it('starts a finished campaign over: the dates go, and it is a draft again', async () => {
    const id = await store.createCampaign({ name: 'Again', inboxId, createdBy: 'tester' })
    await store.setCampaignStatus(id, 'running', { startedAt: new Date() })
    await store.setCampaignStatus(id, 'done', { finishedAt: new Date() })

    await store.resetCampaignForNewRun(id)

    const campaign = await store.getCampaign(id)
    expect(campaign?.status).toBe('draft')
    // setCampaignStatus holds started_at with a COALESCE on purpose, so this is
    // the one thing it cannot do and the reason the reset is its own statement.
    expect(campaign?.startedAt).toBeNull()
    expect(campaign?.finishedAt).toBeNull()
  })

  it('clearing the list takes its send rows with it, which is what lets it send again', async () => {
    const id = await store.createCampaign({ name: 'Twice', inboxId, createdBy: 'tester' })
    await store.insertRecipients(id, [seed('again@example.co.uk')], new Date())
    const { rows } = await store.listRecipients(id, { state: null, search: null, page: 1, perPage: 50 })
    const recipient = rows[0]!

    const sendId = await store.startSend({
      campaignId: id,
      recipientId: recipient.id,
      stepIndex: 0,
      address: recipient.address,
      messageId: 'one@example.co.uk',
    })
    expect(sendId).not.toBeNull()
    await store.settleSend(sendId!, { ok: true, sentAt: new Date(), providerMessageId: null })

    // The duplicate guard, doing its job: the same person and the same step
    // cannot be sent twice while that row stands.
    expect(await store.startSend({
      campaignId: id,
      recipientId: recipient.id,
      stepIndex: 0,
      address: recipient.address,
      messageId: 'two@example.co.uk',
    })).toBeNull()

    // And the cooldown can see them, which is the half that would quietly
    // exclude everybody from a rebuild if the old rows were still there.
    const since = new Date(Date.now() - 7 * 86_400_000)
    expect((await store.recentlyMailedAmong([recipient.address], since)).size).toBe(1)

    await store.clearRecipients(id)

    // ON DELETE CASCADE off the recipient. Both the guard and the cooldown go
    // with it - which is the whole mechanism behind "send it all again", and
    // also exactly what the warning on the screen has to admit is destroyed.
    expect((await store.recentlyMailedAmong([recipient.address], since)).size).toBe(0)
    const after = await db.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*) FROM "uin_campaign_sends" WHERE "campaign_id" = '${id}'`,
    )
    expect(Number(after[0]!.count)).toBe(0)
  })

  it('takes the lane before its clock has come round, but never one already held', async () => {
    const now = new Date()
    const stale = new Date(now.getTime() - 600_000)

    // The lane has to exist before it can be put back with a time on it -
    // releaseLane updates, it does not create - and claiming it is how the
    // runner brings one into being in the first place.
    expect(await store.claimLane(inboxId, now, stale)).toBe(true)

    // An hour of waiting still to go. The ordinary claim leaves it alone; Send
    // now is allowed to take it, because skipping the wait is the whole point.
    await store.releaseLane(inboxId, new Date(now.getTime() + 3_600_000))
    expect(await store.claimLane(inboxId, now, stale)).toBe(false)
    expect(await store.claimLaneNow(inboxId, now, stale)).toBe(true)

    // Held by this claim now, so a second press has to wait: one message at a
    // time from one address is the rule Send now does not get to break.
    expect(await store.claimLaneNow(inboxId, now, stale)).toBe(false)

    await store.abandonLane(inboxId)
    expect(await store.claimLaneNow(inboxId, now, stale)).toBe(true)
    await store.abandonLane(inboxId)
  })

  // ---- M077: archive, design, delivery view, opt-outs -----------------------

  it('keeps archived campaigns off the main list, and brings one back when it can send again', async () => {
    const id = await store.createCampaign({ name: 'Put away', inboxId, createdBy: 'tester' })
    await store.setCampaignStatus(id, 'done', { finishedAt: new Date() })
    await store.setCampaignArchived(id, true)

    expect((await store.listCampaigns()).some((c) => c.id === id)).toBe(false)
    const archived = await store.listCampaigns({ archived: true })
    expect(archived.find((c) => c.id === id)?.archivedAt).toBeInstanceOf(Date)

    // Topped up and going again: nothing that can send may hide in the archive.
    await store.setCampaignStatus(id, 'running', { startedAt: new Date() })
    expect((await store.getCampaign(id))?.archivedAt).toBeNull()

    await store.setCampaignStatus(id, 'stopped')
    await store.setCampaignArchived(id, true)
    await store.resetCampaignForNewRun(id)
    expect((await store.getCampaign(id))?.archivedAt).toBeNull()
  })

  it('stores the email design option', async () => {
    const id = await store.createCampaign({ name: 'Wrapped', inboxId, createdBy: 'tester' })
    expect((await store.getCampaign(id))?.useWrapper).toBe(false)
    await store.updateCampaign(id, { useWrapper: true, wrapperLayoutId: 'layout-1' })
    const campaign = await store.getCampaign(id)
    expect(campaign?.useWrapper).toBe(true)
    expect(campaign?.wrapperLayoutId).toBe('layout-1')
  })

  it('keeps a designed message as a document, and a typed one as none', async () => {
    const id = await store.createCampaign({ name: 'Designed', inboxId, createdBy: 'tester' })
    const design = { root: { props: {} }, content: [{ type: 'EmailHeading', props: { text: "It's {{first_name|you}}" } }] }
    await store.replaceSteps(id, [
      { stepIndex: 0, waitDays: null, subject: 'Hi', body: "It's {{first_name|you}}", bodyDesign: design },
      { stepIndex: 1, waitDays: 3, subject: null, body: 'Typed', bodyDesign: null },
    ])
    const steps = await store.listSteps(id)
    expect(steps[0]?.bodyDesign).toEqual(design)
    expect(steps[1]?.bodyDesign).toBeNull()
  })

  it('reports who it reached, who opened it and who unsubscribed, once each', async () => {
    const id = await store.createCampaign({ name: 'Watched', inboxId, createdBy: 'tester' })
    await store.insertRecipients(id, [seed('read@example.co.uk'), seed('unread@example.co.uk'), seed('waiting@example.co.uk')], new Date())
    const { rows } = await store.listRecipients(id, { state: null, search: null, page: 1, perPage: 50 })
    const byAddress = (a: string) => rows.find((r) => r.address === a)!

    for (const [address, messageId] of [['read@example.co.uk', 'm-read@x'], ['unread@example.co.uk', 'm-unread@x']] as const) {
      const recipient = byAddress(address)
      const sendId = await store.startSend({ campaignId: id, recipientId: recipient.id, stepIndex: 0, address, messageId })
      await store.settleSend(sendId!, { ok: true, sentAt: new Date(), providerMessageId: null })
      if (address === 'read@example.co.uk') {
        await store.recordSendEvent(sendId!, { kind: 'opened', occurredAt: new Date() })
        await store.recordSendEvent(sendId!, { kind: 'clicked', occurredAt: new Date(), detail: 'https://x' })
      }
    }
    await store.advanceRecipient(byAddress('read@example.co.uk').id, {
      sentAt: new Date(), messageId: 'm-read@x', subject: 'Hi', nextStepIndex: null, nextDueAt: null,
    })

    expect(await store.isCampaignMessageId('m-read@x')).toBe(true)
    expect(await store.isCampaignMessageId('somebody-else@x')).toBe(false)

    // The person who has had everything presses the link in it.
    await store.unsubscribeEverywhere('READ@example.co.uk', new Date(), { markFinished: true })

    const reach = await store.campaignEngagement(id)
    expect(reach).toEqual({ sent: 2, delivered: 1, opened: 1, clicked: 1, unsubscribed: 1 })

    const opened = await store.listRecipients(id, { engagement: 'opened', search: null, page: 1, perPage: 50 })
    expect(opened.rows.map((r) => r.address)).toEqual(['read@example.co.uk'])
    // An open is proof it arrived, where the mail service never said so.
    expect(opened.rows[0]?.deliveredAt).toBeInstanceOf(Date)
    expect(opened.rows[0]?.state).toBe('unsubscribed')
    expect(opened.rows[0]?.unsubscribedAt).toBeInstanceOf(Date)

    const unopened = await store.listRecipients(id, { engagement: 'unopened', search: null, page: 1, perPage: 50 })
    expect(unopened.rows.map((r) => r.address)).toEqual(['unread@example.co.uk'])
    expect(unopened.total).toBe(1)

    const gone = await store.listRecipients(id, { engagement: 'unsubscribed', search: null, page: 1, perPage: 50 })
    expect(gone.total).toBe(1)
  })

  it('a suppression added by hand stands down only the people still waiting', async () => {
    const id = await store.createCampaign({ name: 'By hand', inboxId, createdBy: 'tester' })
    await store.insertRecipients(id, [seed('hand@example.co.uk')], new Date())
    const { rows } = await store.listRecipients(id, { state: null, search: null, page: 1, perPage: 50 })
    await store.advanceRecipient(rows[0]!.id, {
      sentAt: new Date(), messageId: 'm-hand@x', subject: 'Hi', nextStepIndex: null, nextDueAt: null,
    })
    expect(await store.unsubscribeEverywhere('hand@example.co.uk', new Date())).toBe(0)
    expect((await store.campaignTally(id)).done).toBe(1)
  })

  it('finds a no to marketing on the card, on an order, and on the account', async () => {
    // No shop on this database yet: the order half has to step aside quietly.
    expect(await consent.hasOptedOutOfMarketing('nobody@example.co.uk')).toBe(false)

    await db.$executeRawUnsafe(
      `INSERT INTO "uin_people" ("display_name", "primary_email", "marketing_consent", "marketing_consent_at")
       VALUES ('Card No', 'card@example.co.uk', false, now())`,
    )
    expect(await consent.hasOptedOutOfMarketing('Card@Example.co.uk')).toBe(true)

    await db.$executeRawUnsafe(
      `INSERT INTO "Member" ("id", "email", "username", "updatedAt", "marketingConsent")
       VALUES ('m-acc', 'account@example.co.uk', 'account', now(), false)`,
    )
    expect(await consent.hasOptedOutOfMarketing('account@example.co.uk')).toBe(true)

    // A shop's orders, with the column the real one has. Read through to_jsonb,
    // so this is the same shape the live query meets.
    await db.$executeRawUnsafe(
      `CREATE TABLE "shp_orders" ("id" TEXT PRIMARY KEY, "customer_email" TEXT, "created_at" TIMESTAMP(3) NOT NULL, "marketing_consent" BOOLEAN)`,
    )
    await db.$executeRawUnsafe(
      `INSERT INTO "shp_orders" VALUES
         ('o1', 'order@example.co.uk', now() - interval '2 days', false),
         ('o2', 'order@example.co.uk', now() - interval '1 day', NULL),
         ('o3', 'changed@example.co.uk', now() - interval '9 days', false)`,
    )
    // A later order that never asked does not hide an earlier no.
    expect(await consent.hasOptedOutOfMarketing('order@example.co.uk')).toBe(true)

    // A yes on the card given after the checkout's no wins.
    await db.$executeRawUnsafe(
      `INSERT INTO "uin_people" ("display_name", "primary_email", "marketing_consent", "marketing_consent_at")
       VALUES ('Changed Mind', 'changed@example.co.uk', true, now())`,
    )
    expect(await consent.hasOptedOutOfMarketing('changed@example.co.uk')).toBe(false)

    // And the audience build sees the order's no for somebody whose card says
    // nothing at all.
    await db.$executeRawUnsafe(
      `INSERT INTO "uin_people" ("display_name", "primary_email") VALUES ('Order Only', 'order@example.co.uk')`,
    )
    const candidates = await store.listAudienceCandidates([])
    expect(candidates.find((c) => c.address === 'order@example.co.uk')?.marketingConsent).toBe(false)
    expect(candidates.find((c) => c.address === 'changed@example.co.uk')?.marketingConsent).toBe(true)
  })

  it('writes an unsubscribe onto every card holding the address, and onto the account', async () => {
    await db.$executeRawUnsafe(
      `INSERT INTO "uin_people" ("display_name", "primary_email", "marketing_consent", "marketing_consent_at")
       VALUES ('Leaving', 'leaving@example.co.uk', true, now() - interval '1 day')`,
    )
    await db.$executeRawUnsafe(
      `INSERT INTO "Member" ("id", "email", "username", "updatedAt", "marketingConsent")
       VALUES ('m-leaving', 'Leaving@example.co.uk', 'leaving', now(), true)`,
    )
    expect(await consent.recordOptOutEverywhere('leaving@example.co.uk', new Date(), 'Unsubscribed by email link')).toBe(1)
    const card = await db.$queryRawUnsafe<{ marketing_consent: boolean; marketing_consent_source: string }[]>(
      `SELECT "marketing_consent", "marketing_consent_source" FROM "uin_people" WHERE "primary_email" = 'leaving@example.co.uk'`,
    )
    expect(card[0]).toEqual({ marketing_consent: false, marketing_consent_source: 'Unsubscribed by email link' })
    const member = await db.$queryRawUnsafe<{ marketingConsent: boolean }[]>(
      `SELECT "marketingConsent" FROM "Member" WHERE "id" = 'm-leaving'`,
    )
    expect(member[0]?.marketingConsent).toBe(false)
    expect(await consent.hasOptedOutOfMarketing('leaving@example.co.uk')).toBe(true)
  })
})

function seed(address: string) {
  return {
    personId: null,
    address,
    firstName: null,
    lastName: null,
    displayName: null,
    organisationName: null,
  }
}
