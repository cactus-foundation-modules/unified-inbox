// ---------------------------------------------------------------------------
// The guards that stop a campaign on their own.
//
// All of them exist because nobody watches a screen for a fortnight. A campaign
// runs for days, and every one of these is a thing that would otherwise be
// discovered afterwards - by which time the domain is in a filter, or two
// thousand people have had the same email twice.
//
// Pure decisions with the numbers passed in, so each one is a test rather than
// a hope.
// ---------------------------------------------------------------------------

/** How many must have gone before the bounce rate means anything. Three
 *  bounces out of the first four is a coincidence; three out of the first fifty
 *  is a list. */
export const BOUNCE_GUARD_MINIMUM = 50

/** The rate at which it stops. Five per cent is roughly where mail services
 *  start treating a sender as a problem, and stopping at four hundred bounces
 *  when the list is five thousand long is the difference between a bad campaign
 *  and a domain nobody's mail reaches from any more. */
export const BOUNCE_GUARD_RATE = 0.05

export type BounceVerdict =
  | { pause: false }
  | { pause: true; reason: string }

/**
 * Whether the bounce rate has got bad enough to stop.
 *
 * Hard bounces only. A full mailbox is a bad afternoon and a deferral is a mail
 * server having a think; neither says anything about the quality of the list,
 * and pausing a fortnight's work over one would be its own kind of failure.
 */
export function bounceVerdict(sent: number, hardBounces: number): BounceVerdict {
  if (sent < BOUNCE_GUARD_MINIMUM) return { pause: false }
  const rate = hardBounces / sent
  if (rate <= BOUNCE_GUARD_RATE) return { pause: false }
  const percent = Math.round(rate * 100)
  return {
    pause: true,
    reason: `${hardBounces} of the first ${sent} came back as bad addresses - that is ${percent} per cent. `
      + 'Sending stopped so the rest of your email keeps arriving. Tidy the list, then start it again.',
  }
}

/**
 * Whether the day's allowance is used up.
 *
 * `allowance` is null for a campaign with no ceiling on it, which is most of
 * them: the gap between messages is already the limit.
 */
export function dayIsFull(sentToday: number, allowance: number | null): boolean {
  return allowance !== null && sentToday >= allowance
}

/**
 * Whether an error the mail service gave back is one worth stopping the whole
 * campaign for, or one to mark against the single recipient and carry on.
 *
 * The distinction is whether the NEXT message would fail for the same reason.
 * An unverified sender, a rejected API key or a service refusing everything is
 * a campaign-wide problem and sending nine hundred more is nine hundred more
 * failures. One address the service will not accept is one address.
 */
export function isCampaignWideFailure(reason: string): boolean {
  const lower = reason.toLowerCase()
  return (
    lower.includes('will not send from that address')
    || lower.includes('no email account set up')
    || lower.includes('details were not accepted')
    || lower.includes('asking us to slow down')
    || lower.includes('could not be reached')
  )
}
