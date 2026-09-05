import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { normaliseAddress } from '../addresses'
import { isRealReply } from './replies'
import type {
  Campaign,
  CampaignPauseKind,
  CampaignRecipient,
  CampaignSend,
  CampaignStatus,
  CampaignStep,
  CampaignTally,
  RecipientState,
  SendWindow,
  Suppression,
  SuppressionReason,
} from './types'
import { RECIPIENT_STATES } from './types'
import type { AudienceCandidate } from './audience'

// ---------------------------------------------------------------------------
// Every read and write against the campaign tables, so the raw column names
// live in exactly one file - the same bargain lib/db.ts strikes for the rest of
// the hub, kept in its own file because that one is five thousand lines already
// and a campaign has nothing to do with collecting the post.
//
// Two things in here are load-bearing and are commented where they happen:
//
//   THE CLAIM. A recipient is moved out of 'queued' in the same statement that
//   finds it, and a send row is written before the mail service is called. Two
//   runs cannot send the same message, and a run that dies mid-send leaves
//   evidence rather than a gap.
//
//   THE LANE. The gap between messages belongs to the sending address, not to
//   the campaign, so it is a row that gets taken and put back rather than a
//   number on each campaign that two campaigns would each honour separately and
//   thereby halve.
// ---------------------------------------------------------------------------

// ---- mapping --------------------------------------------------------------

function windowFrom(r: Record<string, unknown>): SendWindow {
  return {
    startMinute: Number(r.window_start_minute ?? 480),
    endMinute: Number(r.window_end_minute ?? 1020),
    weekdaysOnly: r.weekdays_only === undefined ? true : !!r.weekdays_only,
    skipDates: (r.skip_dates as string[] | null) ?? [],
    intervalSeconds: Number(r.interval_seconds ?? 90),
    jitterSeconds: Number(r.jitter_seconds ?? 0),
    dailyCap: r.daily_cap === null || r.daily_cap === undefined ? null : Number(r.daily_cap),
    rampEnabled: !!r.ramp_enabled,
    rampStart: Number(r.ramp_start ?? 50),
  }
}

function mapCampaign(r: Record<string, unknown>): Campaign {
  return {
    id: r.id as string,
    name: r.name as string,
    inboxId: (r.inbox_id as string | null) ?? null,
    status: r.status as CampaignStatus,
    pauseKind: (r.pause_kind as CampaignPauseKind | null) ?? null,
    pauseReason: (r.pause_reason as string | null) ?? null,
    includeSignature: r.include_signature === undefined ? true : !!r.include_signature,
    includeUnsubscribe: r.include_unsubscribe === undefined ? true : !!r.include_unsubscribe,
    copyToSent: !!r.copy_to_sent,
    startAt: (r.start_at as Date | null) ?? null,
    window: windowFrom(r),
    excludeColleagues: r.exclude_colleagues === undefined ? true : !!r.exclude_colleagues,
    categoryIds: (r.category_ids as string[] | null) ?? [],
    createdBy: (r.created_by as string | null) ?? null,
    testedAt: (r.tested_at as Date | null) ?? null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
    startedAt: (r.started_at as Date | null) ?? null,
    finishedAt: (r.finished_at as Date | null) ?? null,
  }
}

function mapStep(r: Record<string, unknown>): CampaignStep {
  return {
    id: r.id as string,
    campaignId: r.campaign_id as string,
    stepIndex: Number(r.step_index),
    waitDays: r.wait_days === null || r.wait_days === undefined ? null : Number(r.wait_days),
    subject: (r.subject as string | null) ?? null,
    body: (r.body as string | null) ?? '',
  }
}

function mapRecipient(r: Record<string, unknown>): CampaignRecipient {
  return {
    id: r.id as string,
    campaignId: r.campaign_id as string,
    personId: (r.person_id as string | null) ?? null,
    address: r.address as string,
    firstName: (r.first_name as string | null) ?? null,
    lastName: (r.last_name as string | null) ?? null,
    displayName: (r.display_name as string | null) ?? null,
    organisationName: (r.organisation_name as string | null) ?? null,
    state: r.state as RecipientState,
    stepIndex: Number(r.step_index ?? 0),
    dueAt: (r.due_at as Date | null) ?? null,
    claimedAt: (r.claimed_at as Date | null) ?? null,
    firstMessageId: (r.first_message_id as string | null) ?? null,
    lastMessageId: (r.last_message_id as string | null) ?? null,
    firstSubject: (r.first_subject as string | null) ?? null,
    lastSentAt: (r.last_sent_at as Date | null) ?? null,
    repliedAt: (r.replied_at as Date | null) ?? null,
    unsubscribedAt: (r.unsubscribed_at as Date | null) ?? null,
    bouncedAt: (r.bounced_at as Date | null) ?? null,
    reason: (r.reason as string | null) ?? null,
  }
}

function mapSend(r: Record<string, unknown>): CampaignSend {
  return {
    id: r.id as string,
    campaignId: r.campaign_id as string,
    recipientId: r.recipient_id as string,
    stepIndex: Number(r.step_index),
    address: r.address as string,
    status: r.status as CampaignSend['status'],
    error: (r.error as string | null) ?? null,
    messageId: (r.message_id as string | null) ?? null,
    providerMessageId: (r.provider_message_id as string | null) ?? null,
    sentAt: (r.sent_at as Date | null) ?? null,
    deliveredAt: (r.delivered_at as Date | null) ?? null,
    openedAt: (r.opened_at as Date | null) ?? null,
    bouncedAt: (r.bounced_at as Date | null) ?? null,
    bounceKind: (r.bounce_kind as string | null) ?? null,
    bounceDetail: (r.bounce_detail as string | null) ?? null,
  }
}

function mapSuppression(r: Record<string, unknown>): Suppression {
  return {
    id: r.id as string,
    address: r.address as string,
    reason: r.reason as SuppressionReason,
    campaignId: (r.campaign_id as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    createdAt: r.created_at as Date,
  }
}

/** The campaign row plus its category ids in one go, because every screen that
 *  wants one wants the other. */
const CAMPAIGN_SELECT = Prisma.sql`
    SELECT c.*,
           COALESCE(
             (SELECT array_agg(cc."category_id")
                FROM "uin_campaign_categories" cc
               WHERE cc."campaign_id" = c."id"),
             ARRAY[]::text[]
           ) AS category_ids
      FROM "uin_campaigns" c`

// ---- campaigns ------------------------------------------------------------

export async function listCampaigns(): Promise<Campaign[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    ${CAMPAIGN_SELECT}
     ORDER BY
       -- Anything still going first, whatever its age: it is the thing somebody
       -- opened this screen to look at.
       CASE c."status" WHEN 'running' THEN 0 WHEN 'paused' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END,
       c."created_at" DESC
  `
  return rows.map(mapCampaign)
}

export async function getCampaign(id: string): Promise<Campaign | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    ${CAMPAIGN_SELECT}
     WHERE c."id" = ${id}
  `
  return rows[0] ? mapCampaign(rows[0]) : null
}

export async function createCampaign(data: {
  name: string
  inboxId: string | null
  createdBy: string
}): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "uin_campaigns" ("name", "inbox_id", "created_by")
    VALUES (${data.name}, ${data.inboxId}, ${data.createdBy})
    RETURNING "id"
  `
  return rows[0]!.id
}

export type CampaignPatch = {
  name?: string
  inboxId?: string | null
  includeSignature?: boolean
  includeUnsubscribe?: boolean
  copyToSent?: boolean
  startAt?: Date | null
  excludeColleagues?: boolean
  window?: Partial<SendWindow>
}

export async function updateCampaign(id: string, patch: CampaignPatch): Promise<void> {
  const sets: Prisma.Sql[] = []
  if (patch.name !== undefined) sets.push(Prisma.sql`"name" = ${patch.name}`)
  if (patch.inboxId !== undefined) sets.push(Prisma.sql`"inbox_id" = ${patch.inboxId}`)
  if (patch.includeSignature !== undefined) sets.push(Prisma.sql`"include_signature" = ${patch.includeSignature}`)
  if (patch.includeUnsubscribe !== undefined) sets.push(Prisma.sql`"include_unsubscribe" = ${patch.includeUnsubscribe}`)
  if (patch.copyToSent !== undefined) sets.push(Prisma.sql`"copy_to_sent" = ${patch.copyToSent}`)
  if (patch.startAt !== undefined) sets.push(Prisma.sql`"start_at" = ${patch.startAt}`)
  if (patch.excludeColleagues !== undefined) sets.push(Prisma.sql`"exclude_colleagues" = ${patch.excludeColleagues}`)

  const w = patch.window
  if (w) {
    if (w.startMinute !== undefined) sets.push(Prisma.sql`"window_start_minute" = ${w.startMinute}`)
    if (w.endMinute !== undefined) sets.push(Prisma.sql`"window_end_minute" = ${w.endMinute}`)
    if (w.weekdaysOnly !== undefined) sets.push(Prisma.sql`"weekdays_only" = ${w.weekdaysOnly}`)
    if (w.skipDates !== undefined) sets.push(Prisma.sql`"skip_dates" = ${[...w.skipDates]}::text[]`)
    if (w.intervalSeconds !== undefined) sets.push(Prisma.sql`"interval_seconds" = ${w.intervalSeconds}`)
    if (w.jitterSeconds !== undefined) sets.push(Prisma.sql`"jitter_seconds" = ${w.jitterSeconds}`)
    if (w.dailyCap !== undefined) sets.push(Prisma.sql`"daily_cap" = ${w.dailyCap}`)
    if (w.rampEnabled !== undefined) sets.push(Prisma.sql`"ramp_enabled" = ${w.rampEnabled}`)
    if (w.rampStart !== undefined) sets.push(Prisma.sql`"ramp_start" = ${w.rampStart}`)
  }
  if (sets.length === 0) return

  await prisma.$executeRaw`
    UPDATE "uin_campaigns"
       SET ${Prisma.join(sets, ', ')}, "updated_at" = now()
     WHERE "id" = ${id}
  `
}

/**
 * Where the campaign has got to, and why.
 *
 * Every transition goes through here so that the four columns that describe a
 * stopped campaign can never disagree: a running campaign has no pause reason
 * on it, and a paused one always has one.
 */
export async function setCampaignStatus(
  id: string,
  status: CampaignStatus,
  options?: {
    pauseKind?: CampaignPauseKind | null
    pauseReason?: string | null
    startedAt?: Date | null
    finishedAt?: Date | null
  },
): Promise<void> {
  const running = status === 'running'
  await prisma.$executeRaw`
    UPDATE "uin_campaigns"
       SET "status" = ${status},
           "pause_kind" = ${running ? null : (options?.pauseKind ?? null)},
           "pause_reason" = ${running ? null : (options?.pauseReason ?? null)},
           "started_at" = COALESCE("started_at", ${options?.startedAt ?? null}),
           "finished_at" = ${options?.finishedAt ?? null},
           "updated_at" = now()
     WHERE "id" = ${id}
  `
}

export async function setCampaignCategories(id: string, categoryIds: string[]): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "uin_campaign_categories" WHERE "campaign_id" = ${id}`
  if (categoryIds.length === 0) return
  await prisma.$executeRaw`
    INSERT INTO "uin_campaign_categories" ("campaign_id", "category_id")
    SELECT ${id}, x FROM unnest(${categoryIds}::text[]) AS x
    ON CONFLICT DO NOTHING
  `
}

/** Somebody has sent themselves a test of it, which is what unlocks the start
 *  button. Stamped rather than counted: what matters is that one was sent since
 *  it was last a draft, not how many. */
export async function markCampaignTested(id: string, at: Date): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "uin_campaigns" SET "tested_at" = ${at}, "updated_at" = now() WHERE "id" = ${id}
  `
}

export async function deleteCampaign(id: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "uin_campaigns" WHERE "id" = ${id}`
}

// ---- steps ----------------------------------------------------------------

export async function listSteps(campaignId: string): Promise<CampaignStep[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_campaign_steps"
     WHERE "campaign_id" = ${campaignId}
     ORDER BY "step_index" ASC
  `
  return rows.map(mapStep)
}

/**
 * The message and its chases, written as one set.
 *
 * Replacing rather than patching, because the steps are a list somebody edits
 * as a list - adding a chase, removing the middle one, changing the order of
 * the waits - and reconciling that field by field would be three times the code
 * for the same answer. Steps that have already been sent are protected a level
 * up: a running campaign only accepts an edit to a step nobody has reached.
 */
export async function replaceSteps(
  campaignId: string,
  steps: Array<{ stepIndex: number; waitDays: number | null; subject: string | null; body: string }>,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`DELETE FROM "uin_campaign_steps" WHERE "campaign_id" = ${campaignId}`
    for (const step of steps) {
      await tx.$executeRaw`
        INSERT INTO "uin_campaign_steps" ("campaign_id", "step_index", "wait_days", "subject", "body")
        VALUES (${campaignId}, ${step.stepIndex}, ${step.waitDays}, ${step.subject}, ${step.body})
      `
    }
  })
}

// ---- building the list ----------------------------------------------------

/**
 * Everybody in the chosen categories who has an email address, in surname
 * order.
 *
 * An empty category list means the whole address book, which is what "everyone"
 * on the Who step asks for. People who lost a merge are left out here rather
 * than filtered afterwards: they are the same human as somebody else on the
 * list, and mailing both is mailing one person twice.
 *
 * The address is the person's primary one. Somebody with three addresses gets
 * one email, at the address the hub already treats as theirs.
 */
export async function listAudienceCandidates(categoryIds: string[]): Promise<AudienceCandidate[]> {
  const filter = categoryIds.length > 0
    ? Prisma.sql`
        AND EXISTS (
          SELECT 1 FROM "uin_person_categories" pc
           WHERE pc."person_id" = p."id"
             AND pc."category_id" = ANY(${categoryIds}::text[])
        )`
    : Prisma.empty

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT p."id"        AS person_id,
           p."first_name",
           p."last_name",
           p."display_name",
           p."primary_email" AS address,
           o."name"      AS organisation_name
      FROM "uin_people" p
      LEFT JOIN "uin_organisations" o ON o."id" = p."organisation_id"
     WHERE p."merged_into_id" IS NULL
       AND p."primary_email" IS NOT NULL
       AND btrim(p."primary_email") <> ''
       ${filter}
     ORDER BY p."last_name" ASC NULLS LAST, p."first_name" ASC NULLS LAST, p."id" ASC
  `
  return rows.map((r) => ({
    personId: r.person_id as string,
    address: (r.address as string | null) ?? '',
    firstName: (r.first_name as string | null) ?? null,
    lastName: (r.last_name as string | null) ?? null,
    displayName: (r.display_name as string | null) ?? null,
    organisationName: (r.organisation_name as string | null) ?? null,
  }))
}

/** Which of these addresses are on the suppression list. Asked in one query
 *  rather than one per person: a five thousand line list is five thousand
 *  round trips otherwise. */
export async function suppressedAmong(addresses: string[]): Promise<Set<string>> {
  if (addresses.length === 0) return new Set()
  const rows = await prisma.$queryRaw<{ address: string }[]>`
    SELECT lower(btrim("address")) AS address
      FROM "uin_suppressions"
     WHERE lower(btrim("address")) = ANY(${addresses.map((a) => normaliseAddress(a))}::text[])
  `
  return new Set(rows.map((r) => r.address))
}

/** Which of these addresses any campaign has written to since `since`. The
 *  cooldown guard, asked across every campaign there has ever been - the point
 *  is that the customer does not care which mailshot it was. */
export async function recentlyMailedAmong(addresses: string[], since: Date): Promise<Set<string>> {
  if (addresses.length === 0) return new Set()
  const rows = await prisma.$queryRaw<{ address: string }[]>`
    SELECT DISTINCT lower("address") AS address
      FROM "uin_campaign_sends"
     WHERE "sent_at" IS NOT NULL
       AND "sent_at" >= ${since}
       AND lower("address") = ANY(${addresses.map((a) => normaliseAddress(a))}::text[])
  `
  return new Set(rows.map((r) => r.address))
}

/**
 * The list, written down.
 *
 * One statement for the lot rather than a row at a time: five thousand inserts
 * inside a serverless function is a timeout, and the whole list has to land or
 * none of it - a half-built audience that somebody then starts is a campaign
 * that mails half its customers and forgets the rest exists.
 *
 * ON CONFLICT DO NOTHING against the unique index on (campaign, address) is the
 * deduplication rule actually being enforced, rather than trusted to the code
 * that prepared the rows.
 */
export type RecipientSeed = {
  personId: string | null
  address: string
  firstName: string | null
  lastName: string | null
  displayName: string | null
  organisationName: string | null
}

/** Everybody who is getting it, all queued for the same moment - the campaign's
 *  own start, after which the lane decides who goes when. */
export async function insertRecipients(
  campaignId: string,
  rows: readonly RecipientSeed[],
  dueAt: Date,
): Promise<number> {
  if (rows.length === 0) return 0
  return await prisma.$executeRaw`
    INSERT INTO "uin_campaign_recipients"
      ("campaign_id", "person_id", "address", "first_name", "last_name",
       "display_name", "organisation_name", "state", "due_at")
    SELECT ${campaignId}, x."person_id", x."address", x."first_name", x."last_name",
           x."display_name", x."organisation_name", 'queued', ${dueAt}
      FROM unnest(
             ${rows.map((r) => r.personId)}::text[],
             ${rows.map((r) => r.address)}::text[],
             ${rows.map((r) => r.firstName)}::text[],
             ${rows.map((r) => r.lastName)}::text[],
             ${rows.map((r) => r.displayName)}::text[],
             ${rows.map((r) => r.organisationName)}::text[]
           ) AS x("person_id", "address", "first_name", "last_name",
                  "display_name", "organisation_name")
    ON CONFLICT DO NOTHING
  `
}

/** Everybody who is not getting it, and why - written down rather than left
 *  out, because "why is that customer not on this" is the question somebody
 *  asks a fortnight later. */
export async function insertSkipped(
  campaignId: string,
  rows: ReadonlyArray<RecipientSeed & { reason: string }>,
): Promise<number> {
  if (rows.length === 0) return 0
  return await prisma.$executeRaw`
    INSERT INTO "uin_campaign_recipients"
      ("campaign_id", "person_id", "address", "first_name", "last_name",
       "display_name", "organisation_name", "state", "reason")
    SELECT ${campaignId}, x."person_id", x."address", x."first_name", x."last_name",
           x."display_name", x."organisation_name", 'skipped', x."reason"
      FROM unnest(
             ${rows.map((r) => r.personId)}::text[],
             ${rows.map((r) => r.address)}::text[],
             ${rows.map((r) => r.firstName)}::text[],
             ${rows.map((r) => r.lastName)}::text[],
             ${rows.map((r) => r.displayName)}::text[],
             ${rows.map((r) => r.organisationName)}::text[],
             ${rows.map((r) => r.reason)}::text[]
           ) AS x("person_id", "address", "first_name", "last_name",
                  "display_name", "organisation_name", "reason")
    ON CONFLICT DO NOTHING
  `
}

/** Starting again: the whole list goes and is rebuilt. Only ever on a campaign
 *  that has not sent anything, which is checked a level up - rebuilding under a
 *  running campaign would lose the record of what had already gone. */
export async function clearRecipients(campaignId: string): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "uin_campaign_recipients" WHERE "campaign_id" = ${campaignId}
  `
}

/** Every address already on this campaign, so a top-up adds the people who
 *  have appeared since rather than trying to add everybody again. */
export async function existingAddresses(campaignId: string): Promise<Set<string>> {
  const rows = await prisma.$queryRaw<{ address: string }[]>`
    SELECT lower("address") AS address
      FROM "uin_campaign_recipients"
     WHERE "campaign_id" = ${campaignId}
  `
  return new Set(rows.map((r) => r.address))
}

// ---- counting -------------------------------------------------------------

export async function campaignTally(campaignId: string): Promise<CampaignTally> {
  const rows = await prisma.$queryRaw<{ state: string; count: bigint }[]>`
    SELECT "state", COUNT(*)::bigint AS count
      FROM "uin_campaign_recipients"
     WHERE "campaign_id" = ${campaignId}
     GROUP BY "state"
  `
  const tally = Object.fromEntries(RECIPIENT_STATES.map((s) => [s, 0])) as CampaignTally
  tally.total = 0
  for (const row of rows) {
    const count = Number(row.count)
    if ((RECIPIENT_STATES as readonly string[]).includes(row.state)) {
      tally[row.state as RecipientState] = count
    }
    tally.total += count
  }
  return tally
}

/** How many actually left, and how many of those came back as dead addresses.
 *  Both halves of the bounce guard's question in one query. */
export async function sendStats(campaignId: string): Promise<{ sent: number; hardBounces: number }> {
  const rows = await prisma.$queryRaw<{ sent: bigint; bounces: bigint }[]>`
    SELECT COUNT(*) FILTER (WHERE "status" = 'sent')::bigint AS sent,
           COUNT(*) FILTER (WHERE "bounce_kind" IN ('hard', 'invalid', 'blocked'))::bigint AS bounces
      FROM "uin_campaign_sends"
     WHERE "campaign_id" = ${campaignId}
  `
  return { sent: Number(rows[0]?.sent ?? 0), hardBounces: Number(rows[0]?.bounces ?? 0) }
}

/** How many have gone out today, in the site's own zone rather than the
 *  machine's - the daily cap is a promise about a working day. */
export async function sentBetween(campaignId: string, from: Date, to: Date): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
      FROM "uin_campaign_sends"
     WHERE "campaign_id" = ${campaignId}
       AND "status" = 'sent'
       AND "sent_at" >= ${from}
       AND "sent_at" < ${to}
  `
  return Number(rows[0]?.count ?? 0)
}

/**
 * Which day of sending this is, counting only the days anything actually went
 * out on. The warm-up ramp needs it, and it has to be the site's calendar day
 * rather than the machine's or a campaign that starts at four in the afternoon
 * gets two ramp days out of one.
 */
export async function sendingDayNumber(campaignId: string, timezone: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(DISTINCT (("sent_at" AT TIME ZONE 'UTC') AT TIME ZONE ${timezone})::date)::bigint AS count
      FROM "uin_campaign_sends"
     WHERE "campaign_id" = ${campaignId}
       AND "sent_at" IS NOT NULL
  `
  // Nothing sent yet means today will be the first.
  return Math.max(1, Number(rows[0]?.count ?? 0))
}

// ---- the queue ------------------------------------------------------------

export async function listRunnableCampaigns(now: Date): Promise<Campaign[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    ${CAMPAIGN_SELECT}
     WHERE c."status" = 'running'
       AND (c."start_at" IS NULL OR c."start_at" <= ${now})
     ORDER BY c."started_at" ASC NULLS FIRST
  `
  return rows.map(mapCampaign)
}

/**
 * Take the sending address's lane, if it is free and its clock has come round.
 *
 * Returns false when another run has it, or when the next message is not due
 * yet. Both are ordinary answers rather than failures: the tick moves on to the
 * next campaign and comes back.
 *
 * `staleBefore` is what releases a lane held by a run that died. Nothing was
 * sent under a claim that was never settled - the claim happens before the
 * send - so releasing it costs nothing but a duplicate cannot come of it
 * either, because the send row is what actually prevents that.
 */
export async function claimLane(
  inboxId: string,
  now: Date,
  staleBefore: Date,
): Promise<boolean> {
  await prisma.$executeRaw`
    INSERT INTO "uin_campaign_lanes" ("inbox_id", "next_send_at")
    VALUES (${inboxId}, ${now})
    ON CONFLICT ("inbox_id") DO NOTHING
  `
  const claimed = await prisma.$executeRaw`
    UPDATE "uin_campaign_lanes"
       SET "claimed_at" = ${now}
     WHERE "inbox_id" = ${inboxId}
       AND "next_send_at" <= ${now}
       AND ("claimed_at" IS NULL OR "claimed_at" < ${staleBefore})
  `
  return claimed > 0
}

/** Put the lane back with the next moment anything may leave this address. */
export async function releaseLane(inboxId: string, nextSendAt: Date): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "uin_campaign_lanes"
       SET "claimed_at" = NULL,
           "next_send_at" = ${nextSendAt}
     WHERE "inbox_id" = ${inboxId}
  `
}

/** Put it back without moving the clock, for a run that took the lane and then
 *  found nothing to send. */
export async function abandonLane(inboxId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "uin_campaign_lanes" SET "claimed_at" = NULL WHERE "inbox_id" = ${inboxId}
  `
}

export async function laneNextSendAt(inboxId: string): Promise<Date | null> {
  const rows = await prisma.$queryRaw<{ next_send_at: Date }[]>`
    SELECT "next_send_at" FROM "uin_campaign_lanes" WHERE "inbox_id" = ${inboxId}
  `
  return rows[0]?.next_send_at ?? null
}

/**
 * The next person due on this campaign, taken out of the queue in the same
 * statement that finds it.
 *
 * FOR UPDATE SKIP LOCKED is what lets two ticks run at once without either
 * waiting on the other or both taking the same row - the same arrangement the
 * scheduled composer uses, for the same reason.
 */
export async function claimNextRecipient(
  campaignId: string,
  now: Date,
): Promise<CampaignRecipient | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    UPDATE "uin_campaign_recipients"
       SET "state" = 'sending',
           "claimed_at" = ${now}
     WHERE "id" IN (
       SELECT "id" FROM "uin_campaign_recipients"
        WHERE "campaign_id" = ${campaignId}
          AND "state" = 'queued'
          AND ("due_at" IS NULL OR "due_at" <= ${now})
        ORDER BY "due_at" ASC NULLS FIRST, "created_at" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING *
  `
  return rows[0] ? mapRecipient(rows[0]) : null
}

/** Claims from a run that died between taking somebody and settling them. Put
 *  back rather than failed: the send row says whether anything actually went,
 *  and it is the send row that stops a second copy. */
export async function releaseStaleRecipientClaims(before: Date): Promise<number> {
  return await prisma.$executeRaw`
    UPDATE "uin_campaign_recipients"
       SET "state" = 'queued',
           "claimed_at" = NULL
     WHERE "state" = 'sending'
       AND ("claimed_at" IS NULL OR "claimed_at" < ${before})
  `
}

/** Back in the queue, now, without waiting for the stale sweep - for a run that
 *  claimed somebody and then decided not to send after all. */
export async function requeueRecipient(id: string, dueAt: Date | null): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "uin_campaign_recipients"
       SET "state" = 'queued',
           "claimed_at" = NULL,
           "due_at" = ${dueAt},
           "updated_at" = now()
     WHERE "id" = ${id} AND "state" = 'sending'
  `
}

export async function setRecipientState(
  id: string,
  state: RecipientState,
  options?: { reason?: string | null; at?: Date },
): Promise<void> {
  const at = options?.at ?? new Date()
  await prisma.$executeRaw`
    UPDATE "uin_campaign_recipients"
       SET "state" = ${state},
           "claimed_at" = NULL,
           "due_at" = NULL,
           "reason" = ${options?.reason ?? null},
           "replied_at" = CASE WHEN ${state} = 'replied' THEN ${at} ELSE "replied_at" END,
           "unsubscribed_at" = CASE WHEN ${state} = 'unsubscribed' THEN ${at} ELSE "unsubscribed_at" END,
           "bounced_at" = CASE WHEN ${state} IN ('bounced', 'complained') THEN ${at} ELSE "bounced_at" END,
           "updated_at" = now()
     WHERE "id" = ${id}
  `
}

/**
 * One step has gone. Move them on to the next one, or finish them.
 *
 * `nextDueAt` null means there is no next step, which is what 'done' says.
 */
export async function advanceRecipient(
  id: string,
  data: {
    sentAt: Date
    messageId: string
    subject: string
    nextStepIndex: number | null
    nextDueAt: Date | null
  },
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "uin_campaign_recipients"
       SET "state" = ${data.nextStepIndex === null ? 'done' : 'queued'},
           "step_index" = ${data.nextStepIndex ?? 0},
           "due_at" = ${data.nextDueAt},
           "claimed_at" = NULL,
           "last_sent_at" = ${data.sentAt},
           "last_message_id" = ${data.messageId},
           -- The first message is what every chase is threaded onto, so it is
           -- written once and never overwritten.
           "first_message_id" = COALESCE("first_message_id", ${data.messageId}),
           "first_subject" = COALESCE("first_subject", ${data.subject}),
           "updated_at" = now()
     WHERE "id" = ${id}
  `
}

// ---- sends ----------------------------------------------------------------

/**
 * Write down that we are about to send, BEFORE the mail service is called.
 *
 * Returns null when a row for this recipient and step already exists, which
 * means somebody or something has already sent it. That is the duplicate guard,
 * and it is a unique index rather than a check-then-act: two runs asking at the
 * same moment both get an answer, and only one of them gets a row.
 */
export async function startSend(data: {
  campaignId: string
  recipientId: string
  stepIndex: number
  address: string
  messageId: string
}): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "uin_campaign_sends"
      ("campaign_id", "recipient_id", "step_index", "address", "message_id", "status")
    VALUES (${data.campaignId}, ${data.recipientId}, ${data.stepIndex},
            ${data.address}, ${data.messageId}, 'sending')
    ON CONFLICT ("recipient_id", "step_index") DO NOTHING
    RETURNING "id"
  `
  return rows[0]?.id ?? null
}

export async function settleSend(
  id: string,
  outcome: { ok: true; sentAt: Date; providerMessageId: string | null } | { ok: false; error: string },
): Promise<void> {
  if (outcome.ok) {
    await prisma.$executeRaw`
      UPDATE "uin_campaign_sends"
         SET "status" = 'sent',
             "sent_at" = ${outcome.sentAt},
             "provider_message_id" = ${outcome.providerMessageId},
             "error" = NULL
       WHERE "id" = ${id}
    `
    return
  }
  await prisma.$executeRaw`
    UPDATE "uin_campaign_sends"
       SET "status" = 'failed',
           "error" = ${outcome.error}
     WHERE "id" = ${id}
  `
}

export async function listSendsForRecipient(recipientId: string): Promise<CampaignSend[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_campaign_sends"
     WHERE "recipient_id" = ${recipientId}
     ORDER BY "step_index" ASC
  `
  return rows.map(mapSend)
}

/**
 * What the mail service later said about one of these messages.
 *
 * Matched on the send's own id, which travelled out in the tracking header, so
 * an event about an order confirmation or a password reset lands nowhere near
 * here.
 */
export async function recordSendEvent(
  sendId: string,
  event: {
    kind: 'delivered' | 'opened' | 'bounced'
    occurredAt: Date
    bounceKind?: string | null
    detail?: string | null
  },
): Promise<CampaignSend | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    UPDATE "uin_campaign_sends"
       SET "delivered_at" = CASE WHEN ${event.kind} = 'delivered'
                                 THEN COALESCE("delivered_at", ${event.occurredAt}) ELSE "delivered_at" END,
           "opened_at" = CASE WHEN ${event.kind} = 'opened'
                              THEN COALESCE("opened_at", ${event.occurredAt}) ELSE "opened_at" END,
           "bounced_at" = CASE WHEN ${event.kind} = 'bounced'
                               THEN COALESCE("bounced_at", ${event.occurredAt}) ELSE "bounced_at" END,
           "bounce_kind" = CASE WHEN ${event.kind} = 'bounced'
                                THEN ${event.bounceKind ?? null} ELSE "bounce_kind" END,
           "bounce_detail" = CASE WHEN ${event.kind} = 'bounced'
                                  THEN ${event.detail ?? null} ELSE "bounce_detail" END
     WHERE "id" = ${sendId}
    RETURNING *
  `
  return rows[0] ? mapSend(rows[0]) : null
}

// ---- replies --------------------------------------------------------------

/**
 * Has this person written back since we last wrote to them.
 *
 * Asked of one recipient at the moment a chase is about to go, which is the
 * moment it matters and is also what keeps it cheap: the alternative is joining
 * every inbound message against every recipient on every tick.
 *
 * Three ways of being the same human, because they are all real: the
 * conversation is filed against them, the mail came from the address we wrote
 * to, or it came from another address the hub already knows is theirs. Anything
 * the collector marked as machinery - a bounce, a mailing list, an
 * out-of-office - is not a reply, and neither is an out-of-office whose
 * headers said nothing (see lib/campaigns/replies.ts).
 */
export async function hasRepliedSince(recipient: {
  personId: string | null
  address: string
  lastSentAt: Date | null
}): Promise<boolean> {
  if (!recipient.lastSentAt) return false
  const address = normaliseAddress(recipient.address)
  const rows = await prisma.$queryRaw<{ subject: string | null; auto_kind: string | null }[]>`
    SELECT m."subject", m."auto_kind"
      FROM "uin_messages" m
      LEFT JOIN "uin_threads" t ON t."id" = m."thread_id"
     WHERE m."direction" = 'in'
       AND m."sent_at" > ${recipient.lastSentAt}
       AND m."auto_kind" IS NULL
       AND (
         lower(m."from_address") = ${address}
         OR (${recipient.personId}::text IS NOT NULL AND t."person_id" = ${recipient.personId})
         OR (${recipient.personId}::text IS NOT NULL AND EXISTS (
              SELECT 1 FROM "uin_person_identities" pi
               WHERE pi."person_id" = ${recipient.personId}
                 AND pi."match_value" = lower(m."from_address")
            ))
       )
     ORDER BY m."sent_at" DESC
     LIMIT 20
  `
  return rows.some((row) => isRealReply({ autoKind: row.auto_kind, subject: row.subject }))
}

/**
 * The same question asked of the whole campaign, so the Watch table shows a
 * reply the moment it lands rather than only when the chase would have gone.
 *
 * Bounded on purpose: it runs on every tick and must never become the reason a
 * tick runs out of time. Whatever it does not get to this time it gets to next
 * time, and the per-recipient check above is the one that actually decides
 * whether a chase goes out.
 */
export async function sweepReplies(campaignId: string, limit: number): Promise<number> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_campaign_recipients"
     WHERE "campaign_id" = ${campaignId}
       AND "state" = 'queued'
       AND "last_sent_at" IS NOT NULL
     ORDER BY "last_sent_at" ASC
     LIMIT ${limit}
  `
  let found = 0
  for (const row of rows) {
    const recipient = mapRecipient(row)
    if (await hasRepliedSince(recipient)) {
      await setRecipientState(recipient.id, 'replied')
      found += 1
    }
  }
  return found
}

// ---- the Watch table ------------------------------------------------------

export async function listRecipients(
  campaignId: string,
  filters: { state?: RecipientState | null; search?: string | null; page: number; perPage: number },
): Promise<{ rows: CampaignRecipient[]; total: number }> {
  const conditions: Prisma.Sql[] = [Prisma.sql`"campaign_id" = ${campaignId}`]
  if (filters.state) conditions.push(Prisma.sql`"state" = ${filters.state}`)
  if (filters.search) {
    const like = `%${filters.search.toLowerCase()}%`
    conditions.push(Prisma.sql`(
      lower("address") LIKE ${like}
      OR lower(COALESCE("display_name", '')) LIKE ${like}
      OR lower(COALESCE("first_name", '') || ' ' || COALESCE("last_name", '')) LIKE ${like}
      OR lower(COALESCE("organisation_name", '')) LIKE ${like}
    )`)
  }
  const where = Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_campaign_recipients"
    ${where}
     ORDER BY "last_sent_at" DESC NULLS LAST, "created_at" ASC
     LIMIT ${filters.perPage} OFFSET ${(filters.page - 1) * filters.perPage}
  `
  const counted = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "uin_campaign_recipients" ${where}
  `
  return { rows: rows.map(mapRecipient), total: Number(counted[0]?.count ?? 0) }
}

/** Why people were left out, grouped, for the Who step. Counted in the
 *  database rather than by reading five thousand rows into memory to count
 *  them. */
export async function exclusionSummary(campaignId: string): Promise<Array<{ reason: string; count: number }>> {
  const rows = await prisma.$queryRaw<{ reason: string | null; count: bigint }[]>`
    SELECT "reason", COUNT(*)::bigint AS count
      FROM "uin_campaign_recipients"
     WHERE "campaign_id" = ${campaignId} AND "state" = 'skipped'
     GROUP BY "reason"
     ORDER BY count DESC
  `
  return rows.map((r) => ({ reason: r.reason ?? 'No reason recorded.', count: Number(r.count) }))
}

/** A handful of real people off the list, for the preview. Real ones because
 *  the entire value of a preview is spotting the contact whose first name is
 *  "Accounts Dept". */
export async function previewRecipients(campaignId: string, limit: number): Promise<CampaignRecipient[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_campaign_recipients"
     WHERE "campaign_id" = ${campaignId} AND "state" <> 'skipped'
     ORDER BY
       -- One with no first name first, if there is one: it is the row that
       -- shows whether the fallback works, which is the whole question.
       CASE WHEN COALESCE(btrim("first_name"), '') = '' THEN 0 ELSE 1 END,
       "created_at" ASC
     LIMIT ${limit}
  `
  return rows.map(mapRecipient)
}

// ---- suppressions ---------------------------------------------------------

export async function addSuppression(data: {
  address: string
  reason: SuppressionReason
  campaignId?: string | null
  note?: string | null
}): Promise<void> {
  const address = normaliseAddress(data.address)
  if (!address) return
  await prisma.$executeRaw`
    INSERT INTO "uin_suppressions" ("address", "reason", "campaign_id", "note")
    VALUES (${address}, ${data.reason}, ${data.campaignId ?? null}, ${data.note ?? null})
    ON CONFLICT DO NOTHING
  `
}

export async function isSuppressed(address: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ one: number }[]>`
    SELECT 1 AS one FROM "uin_suppressions"
     WHERE lower(btrim("address")) = ${normaliseAddress(address)}
     LIMIT 1
  `
  return rows.length > 0
}

export async function listSuppressions(filters: {
  search?: string | null
  page: number
  perPage: number
}): Promise<{ rows: Suppression[]; total: number }> {
  const conditions: Prisma.Sql[] = [Prisma.sql`TRUE`]
  if (filters.search) {
    conditions.push(Prisma.sql`lower("address") LIKE ${`%${filters.search.toLowerCase()}%`}`)
  }
  const where = Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_suppressions" ${where}
     ORDER BY "created_at" DESC
     LIMIT ${filters.perPage} OFFSET ${(filters.page - 1) * filters.perPage}
  `
  const counted = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "uin_suppressions" ${where}
  `
  return { rows: rows.map(mapSuppression), total: Number(counted[0]?.count ?? 0) }
}

export async function removeSuppression(id: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "uin_suppressions" WHERE "id" = ${id}`
}

/**
 * Somebody has asked to stop, so stop everywhere.
 *
 * Not only on the campaign whose link they pressed: every campaign running or
 * about to run, because "unsubscribe" means from this business rather than from
 * one mailshot, and a customer who unsubscribes on Monday and gets a different
 * campaign on Tuesday presses the spam button instead.
 */
export async function unsubscribeEverywhere(address: string, at: Date): Promise<number> {
  return await prisma.$executeRaw`
    UPDATE "uin_campaign_recipients"
       SET "state" = 'unsubscribed',
           "unsubscribed_at" = ${at},
           "due_at" = NULL,
           "claimed_at" = NULL,
           "updated_at" = now()
     WHERE lower("address") = ${normaliseAddress(address)}
       AND "state" IN ('queued', 'sending')
  `
}

/** The same, for an address that has turned out to be dead. */
export async function markAddressBounced(address: string, at: Date, reason: string): Promise<number> {
  return await prisma.$executeRaw`
    UPDATE "uin_campaign_recipients"
       SET "state" = 'bounced',
           "bounced_at" = ${at},
           "reason" = ${reason},
           "due_at" = NULL,
           "claimed_at" = NULL,
           "updated_at" = now()
     WHERE lower("address") = ${normaliseAddress(address)}
       AND "state" IN ('queued', 'sending')
  `
}

// ---- housekeeping ---------------------------------------------------------

/**
 * The send-by-send ledger of campaigns that finished long enough ago.
 *
 * The recipient rows are what hold the personal data - a name, an address, a
 * company - so those are what go; the campaign itself stays, because "we sent
 * that in March" is a fact about the business rather than about a person.
 *
 * Batched, like every other sweep in this module: a site with four years of
 * campaigns catches up over a few nights rather than trying to do it in one.
 */
export async function pruneCampaignLogs(cutoff: Date, batch: number): Promise<number> {
  return await prisma.$executeRaw`
    DELETE FROM "uin_campaign_recipients"
     WHERE "id" IN (
       SELECT r."id"
         FROM "uin_campaign_recipients" r
         JOIN "uin_campaigns" c ON c."id" = r."campaign_id"
        WHERE c."finished_at" IS NOT NULL
          AND c."finished_at" < ${cutoff}
        LIMIT ${batch}
     )
  `
}

/** Everything the erase route has to be told about, so a contact who asks to be
 *  forgotten is not still sitting in a campaign queue. The recipient rows go
 *  with the person by foreign key; this is the count, for the preview that says
 *  what will happen before it happens. */
export async function campaignRowsForPerson(personId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
      FROM "uin_campaign_recipients"
     WHERE "person_id" = ${personId}
  `
  return Number(rows[0]?.count ?? 0)
}
