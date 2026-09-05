import { getSettings, listInboxes } from '../db'
import { resolveOwnDomains } from '../people'
import { buildAudience, type AudienceCandidate, type AudienceGate } from './audience'
import {
  clearRecipients,
  existingAddresses,
  insertRecipients,
  insertSkipped,
  listAudienceCandidates,
  recentlyMailedAmong,
  suppressedAmong,
} from './store'
import type { Campaign } from './types'

// ---------------------------------------------------------------------------
// Working out the list, and writing it down.
//
// Fixed at the moment it is built rather than evaluated as the campaign runs.
// A live list is a list whose finish date moves every time somebody imports a
// spreadsheet, and whose count on the review screen was a lie by the time it
// started. Somebody who wants the people who have appeared since presses Top
// up, which is the same work with the existing addresses held back.
//
// Everybody who is NOT getting it is written down too, with the reason. It
// costs a row each and it answers the question somebody actually asks a
// fortnight later, which is never "how many went" but "why did that one not".
// ---------------------------------------------------------------------------

export type AudienceSummary = {
  /** How many will be written to. */
  included: number
  /** How many were left out, and why, biggest reason first. */
  excluded: Array<{ reason: string; count: number }>
  /** Two contacts sharing an address, or one contact in two of the chosen
   *  categories. Counted rather than listed: it is a number somebody wants
   *  reassurance about, not a list they want to read. */
  duplicates: number
}

/** The gate every candidate is measured against: what the site's settings say,
 *  and what has already happened to these addresses elsewhere. */
async function gateFor(
  campaign: Campaign,
  candidates: readonly AudienceCandidate[],
): Promise<AudienceGate> {
  const settings = await getSettings()
  const inboxes = await listInboxes()
  const addresses = candidates.map((c) => c.address)

  const cooldownDays = settings.campaignCooldownDays
  const since = new Date(Date.now() - cooldownDays * 86_400_000)

  const [suppressed, recentlyMailed] = await Promise.all([
    suppressedAmong(addresses),
    cooldownDays > 0 ? recentlyMailedAmong(addresses, since) : Promise.resolve(new Set<string>()),
  ])

  return {
    suppressed,
    recentlyMailed,
    ownDomains: resolveOwnDomains(
      inboxes.map((i) => i.address),
      settings.ownDomains,
      settings.personalDomains,
    ),
    excludeColleagues: campaign.excludeColleagues,
    cooldownDays,
  }
}

/**
 * Build the list from scratch.
 *
 * Only ever on a campaign that has not sent anything - checked by the caller,
 * because clearing the list under a running campaign would throw away the
 * record of what had already gone out and start writing to those people again.
 */
export async function buildAudienceFor(
  campaign: Campaign,
  startAt: Date,
): Promise<AudienceSummary> {
  const candidates = await listAudienceCandidates(campaign.categoryIds)
  const gate = await gateFor(campaign, candidates)
  const built = buildAudience(candidates, gate)

  await clearRecipients(campaign.id)
  await insertRecipients(campaign.id, built.included.map(toSeed), startAt)
  await insertSkipped(
    campaign.id,
    built.excluded.map((row) => ({ ...toSeed(row.candidate), reason: row.reason })),
  )

  return summarise(built)
}

/**
 * The people who have appeared in those categories since the list was built.
 *
 * Everybody already on the campaign is left exactly as they are, whatever state
 * they are in - including the ones who unsubscribed, who must not quietly
 * return to the queue because somebody pressed Top up.
 */
export async function topUpAudienceFor(
  campaign: Campaign,
  dueAt: Date,
): Promise<AudienceSummary> {
  const already = await existingAddresses(campaign.id)
  const candidates = (await listAudienceCandidates(campaign.categoryIds))
    .filter((c) => !already.has(c.address.trim().toLowerCase()))
  const gate = await gateFor(campaign, candidates)
  const built = buildAudience(candidates, gate)

  await insertRecipients(campaign.id, built.included.map(toSeed), dueAt)
  await insertSkipped(
    campaign.id,
    built.excluded.map((row) => ({ ...toSeed(row.candidate), reason: row.reason })),
  )

  return summarise(built)
}

/**
 * Send the whole thing again, to everybody, including the people who have
 * already had it.
 *
 * For the campaign somebody runs at a test mailbox twenty times while they get
 * the wording right, and for the annual reminder that goes to the same list
 * every September. It is a knife, and the screen holds it by the handle: it is
 * only offered on a campaign that has FINISHED, and only behind a warning that
 * says in so many words that people will get a second copy.
 *
 * THE OLD ROWS GO FIRST, AND THAT ORDER IS THE WHOLE FUNCTION. Two reasons, and
 * both of them bite silently:
 *
 * The cooldown is asked of `uin_campaign_sends` by address, across every
 * campaign - so this campaign's own sends, from the run that finished ten
 * minutes ago, would exclude every single person it just wrote to, and the
 * rebuild would come back with nobody on it. `buildAudienceFor` asks that
 * question BEFORE it clears anything, so clearing has to happen before it is
 * called rather than inside it.
 *
 * And the send rows carry a UNIQUE on (recipient, step), which is what makes a
 * duplicate impossible. Keeping the old recipient rows would therefore mean the
 * second run quietly sent nobody anything - every message would hit that index
 * and be skipped as already sent. New recipient rows are what make a second
 * copy possible at all.
 *
 * The cost, which the screen has to say out loud: the send rows cascade off the
 * recipients, so the record of what went out in the previous run goes with
 * them. What does NOT go is anybody's unsubscribe - suppressions are their own
 * table, they outlive the campaign, and the rebuild leaves those people out
 * exactly as it did the first time.
 */
export async function restartAudienceFor(
  campaign: Campaign,
  startAt: Date,
): Promise<AudienceSummary> {
  await clearRecipients(campaign.id)
  return await buildAudienceFor(campaign, startAt)
}

/** What the Who step shows before anything is written down: the same decision,
 *  without the rows. */
export async function previewAudienceFor(campaign: Campaign): Promise<AudienceSummary> {
  const candidates = await listAudienceCandidates(campaign.categoryIds)
  const gate = await gateFor(campaign, candidates)
  return summarise(buildAudience(candidates, gate))
}

function toSeed(candidate: AudienceCandidate) {
  return {
    personId: candidate.personId,
    address: candidate.address,
    firstName: candidate.firstName,
    lastName: candidate.lastName,
    displayName: candidate.displayName,
    organisationName: candidate.organisationName,
  }
}

function summarise(built: ReturnType<typeof buildAudience>): AudienceSummary {
  const counts = new Map<string, number>()
  for (const row of built.excluded) counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1)
  return {
    included: built.included.length,
    excluded: [...counts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    duplicates: built.duplicates,
  }
}
