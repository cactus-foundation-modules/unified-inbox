import { isValidAddress, normaliseAddress } from '../addresses'
import { domainOf } from '../people'
import type { RecipientNames } from './types'

// ---------------------------------------------------------------------------
// Who is on the list, and - just as important - who is not, and why.
//
// The reason a name is missing is a question somebody asks a fortnight later,
// usually about the one customer they particularly wanted to reach, and "it
// just was not in there" is not an answer. So every exclusion below produces a
// sentence, the sentence is stored on the row, and the Who step shows the lot
// grouped by reason before anybody presses start.
//
// All of it is a pure decision over a candidate and a gate, so the awkward
// cases are tests rather than a live campaign to two thousand people.
// ---------------------------------------------------------------------------

export type AudienceCandidate = RecipientNames & {
  personId: string
}

export type AudienceGate = {
  /** Addresses nobody may write to again, normalised. */
  suppressed: ReadonlySet<string>
  /** Addresses another campaign has written to inside the cooldown, normalised. */
  recentlyMailed: ReadonlySet<string>
  /** Domains that mean "one of us" (see lib/people.ts, E18). */
  ownDomains: readonly string[]
  excludeColleagues: boolean
  /** Only used to word the cooldown refusal, so the screen says "in the last
   *  seven days" rather than "recently". */
  cooldownDays: number
}

export type AudienceDecision =
  | { include: true; address: string }
  | { include: false; reason: string }

/**
 * Whether one contact gets this campaign.
 *
 * The order is deliberate: the reasons that are about the ADDRESS come before
 * the ones that are about timing, because "that address does not work" is worth
 * knowing even about somebody who would also have been held back by the
 * cooldown, and the first reason found is the one that gets shown.
 */
export function decideAudience(
  candidate: AudienceCandidate,
  gate: AudienceGate,
): AudienceDecision {
  const address = normaliseAddress(candidate.address ?? '')

  if (!address) {
    return { include: false, reason: 'No email address on their record.' }
  }
  if (!isValidAddress(address)) {
    return { include: false, reason: 'The email address on their record is not one that will work.' }
  }
  if (gate.suppressed.has(address)) {
    return { include: false, reason: 'They have unsubscribed, or their address has bounced.' }
  }
  if (gate.excludeColleagues) {
    const domain = domainOf(address)
    if (domain && gate.ownDomains.includes(domain)) {
      return { include: false, reason: 'They are a colleague rather than a customer.' }
    }
  }
  if (gate.recentlyMailed.has(address)) {
    const days = gate.cooldownDays
    return {
      include: false,
      reason: `Another campaign wrote to them in the last ${days} day${days === 1 ? '' : 's'}.`,
    }
  }
  return { include: true, address }
}

/**
 * A whole list of candidates decided at once, deduplicated by address.
 *
 * Two contacts genuinely do share an address - a husband and wife at one
 * mailbox, a shop and its owner - and the same person is genuinely in two of
 * the chosen categories. The first one wins, which is the one the query
 * ordered first, which is surname order: arbitrary, but stable, so building the
 * same list twice produces the same list.
 *
 * The database has the same rule as a unique index, which is what actually
 * guarantees it. This is here so the screen can SAY how many were duplicates
 * before anybody presses start.
 */
export function buildAudience(
  candidates: readonly AudienceCandidate[],
  gate: AudienceGate,
): {
  included: Array<AudienceCandidate & { address: string }>
  excluded: Array<{ candidate: AudienceCandidate; reason: string }>
  duplicates: number
} {
  const seen = new Set<string>()
  const included: Array<AudienceCandidate & { address: string }> = []
  const excluded: Array<{ candidate: AudienceCandidate; reason: string }> = []
  let duplicates = 0

  for (const candidate of candidates) {
    const decision = decideAudience(candidate, gate)
    if (!decision.include) {
      excluded.push({ candidate, reason: decision.reason })
      continue
    }
    if (seen.has(decision.address)) {
      duplicates += 1
      continue
    }
    seen.add(decision.address)
    included.push({ ...candidate, address: decision.address })
  }

  return { included, excluded, duplicates }
}

/** The exclusions grouped for the panel that shows them: one line per reason
 *  with a count, biggest first, because "1,204 have unsubscribed" is the line
 *  somebody needs to see and a list of 1,204 names is not. */
export function groupExclusions(
  excluded: ReadonlyArray<{ reason: string }>,
): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>()
  for (const row of excluded) counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1)
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
}
