import { normaliseBrevoReportEvent } from './receipts'
import type { ReportedDeliveryEvent } from './receipts'

// ---------------------------------------------------------------------------
// Asking Brevo what it remembers about one message.
//
// The webhook is how events reach this module as they happen. This is the
// other direction: the history screen under a sent reply asks Brevo's event
// report for everything it holds about that one message, because the report
// carries the one thing the webhook never does - the network address each
// open or click came from - and because it also remembers things from before
// the webhook was switched on.
//
// Nothing in here throws. A key that has expired, a message Brevo has since
// forgotten, or Brevo being down for a minute all come back as "nothing
// learned, and here is why", and the screen shows the ledger on its own. A
// history that will not open because a third party is slow is a fault; a
// history missing its addresses for a minute is not.
// ---------------------------------------------------------------------------

const BREVO_API = 'https://api.brevo.com/v3'
const TIMEOUT_MS = 8_000

/** How far either side of the send the report is asked about. Brevo takes a
 *  span of at most ninety days, and nothing about a message is worth a line
 *  three months after it went. */
const REPORT_SPAN_DAYS = 89

export type BrevoReport =
  | { ok: true; events: ReportedDeliveryEvent[] }
  | { ok: false; reason: string }

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** The window the report is asked about, as the two dates Brevo wants. From
 *  the day before the send (their clock and ours need not agree on midnight)
 *  to eighty-nine days after it, capped at today. */
export function reportWindow(sentAt: Date, now = new Date()): { startDate: string; endDate: string } {
  const start = new Date(sentAt.getTime() - 86_400_000)
  const end = new Date(Math.min(start.getTime() + REPORT_SPAN_DAYS * 86_400_000, now.getTime()))
  return { startDate: isoDay(start), endDate: isoDay(end < start ? start : end) }
}

async function fetchReport(apiKey: string, query: URLSearchParams): Promise<{ ok: true; body: unknown } | { ok: false; status: number | null; reason: string }> {
  try {
    const res = await fetch(`${BREVO_API}/smtp/statistics/events?${query.toString()}`, {
      headers: { 'api-key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      if (res.status === 401) return { ok: false, status: 401, reason: 'That email account key was not accepted.' }
      return { ok: false, status: res.status, reason: `The email service refused (${res.status}).` }
    }
    return { ok: true, body: await res.json().catch(() => ({})) }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: false, status: null, reason: `The email service could not be reached. ${reason.slice(0, 120)}` }
  }
}

function eventsOf(body: unknown): unknown[] {
  const list = (body as { events?: unknown })?.events
  return Array.isArray(list) ? list : []
}

/**
 * Everything Brevo remembers about one message, in our terms.
 *
 * Tried on each key in turn until one answers with something: a message went
 * out on exactly one account, and the caller has put its best guess first.
 * The id is asked for both with and without its angle brackets, because the
 * report has been seen to want each at different times and a wrong guess is
 * an empty list rather than an error.
 */
export async function fetchBrevoMessageHistory(input: {
  providerMessageId: string
  sentAt: Date
  apiKeys: string[]
}): Promise<BrevoReport> {
  if (input.apiKeys.length === 0) {
    return { ok: false, reason: 'Nothing here sends through Brevo, so there is no report to ask.' }
  }
  const bare = input.providerMessageId.trim().replace(/^<|>$/g, '')
  if (!bare) return { ok: false, reason: 'The email service never gave this message a name to ask about.' }

  const { startDate, endDate } = reportWindow(input.sentAt)
  let lastFailure: string | null = null

  for (const apiKey of input.apiKeys) {
    for (const messageId of [`<${bare}>`, bare]) {
      const query = new URLSearchParams({ messageId, startDate, endDate, limit: '500', sort: 'asc' })
      const outcome = await fetchReport(apiKey, query)
      if (!outcome.ok) {
        lastFailure = outcome.reason
        // A key Brevo will not take is not going to take the next spelling
        // either. Move on to the next key.
        if (outcome.status === 401) break
        continue
      }
      const events = eventsOf(outcome.body)
        .map((entry) => normaliseBrevoReportEvent(entry))
        .filter((one): one is ReportedDeliveryEvent => one !== null)
      if (events.length > 0) return { ok: true, events }
    }
  }

  return lastFailure
    ? { ok: false, reason: lastFailure }
    : { ok: true, events: [] }
}
