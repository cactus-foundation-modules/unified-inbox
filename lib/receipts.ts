// ---------------------------------------------------------------------------
// What became of a reply after it left.
//
// Everything in this file is pure. Given whatever the mail service pushed at
// us, or whatever a recipient's mail program sent back, it works out which of
// our messages is being talked about and what happened to it. Nothing here
// opens a connection or writes a row, which is the only way the awkward parts
// are testable - and every part of this is awkward, because all of it is
// somebody else's data arriving in somebody else's shape.
//
// The awkward parts, and why they are the way they are:
//
//   Brevo names its events one way when you subscribe to them (hardBounce) and
//   another way when it sends them (hard_bounce). Both are accepted, because
//   discovering that in production means silently filing nothing for a week.
//
//   The same event arrives more than once. Brevo retries anything we do not
//   answer quickly, and a retry is not a second open. Every event carries the
//   moment it happened, and the moment is what the database deduplicates on.
//
//   An "open" is an invisible image being fetched. Apple Mail Privacy
//   Protection and Gmail fetch that image on the reader's behalf, whether or
//   not a human ever looked. Brevo reports those separately, and they are kept
//   separately: telling somebody their customer read the email when the
//   customer's phone merely downloaded it is the kind of wrong that ends in a
//   badly judged phone call.
// ---------------------------------------------------------------------------

/** The strongest thing we know about a message, in the order it is worth. */
export type DeliveryEventKind = 'delivered' | 'opened' | 'proxy_open' | 'bounced' | 'receipt'

export type NormalisedDeliveryEvent = {
  kind: DeliveryEventKind
  occurredAt: Date
  /** A sentence for a person. The bounce reason, mostly. */
  detail: string | null
  /** 'hard' | 'soft' | 'blocked' | 'spam' | 'invalid' | 'deferred' | 'error',
   *  and null for anything that is not a failure. */
  bounceKind: string | null
}

/** The events we ask Brevo to send us, in the spelling its subscription API
 *  wants. Deliberately short: clicks are somebody else's feature, and a
 *  deferral is the mail service talking to itself about a retry it is about to
 *  make anyway. */
export const BREVO_SUBSCRIBED_EVENTS = [
  'delivered',
  'opened',
  'uniqueOpened',
  'hardBounce',
  'softBounce',
  'blocked',
  'spam',
  'invalid',
] as const

/** The header that carries our own message id out with the email and comes
 *  back on every event about it. Brevo passes it through untouched. */
export const CUSTOM_TAG_HEADER = 'X-Mailin-custom'

/** What goes in that header for one message. */
export function customTagFor(messageId: string): string {
  return JSON.stringify({ uin: messageId })
}

/** Our message id back out of it. Tolerates a bare id, because a header that
 *  has been through a mail server is not always the string that went in. */
export function readCustomTag(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (!raw) return null
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as { uin?: unknown }
      return typeof parsed.uin === 'string' && parsed.uin ? parsed.uin : null
    } catch {
      return null
    }
  }
  // A plain id, which is what a well-meaning hand edit of the settings would
  // produce. Anything with a space in it is somebody else's tag, not ours.
  return /^[A-Za-z0-9_-]{8,100}$/.test(raw) ? raw : null
}

const BOUNCE_KINDS: Record<string, string> = {
  hard_bounce: 'hard',
  hardbounce: 'hard',
  soft_bounce: 'soft',
  softbounce: 'soft',
  blocked: 'blocked',
  spam: 'spam',
  invalid_email: 'invalid',
  invalid: 'invalid',
  deferred: 'deferred',
  error: 'error',
}

/** Brevo sends `ts_event` and `ts` as epoch seconds and `date` as a string.
 *  Whichever it gives us, the moment matters: it is what stops a redelivered
 *  event counting as a second open. */
function eventMoment(payload: Record<string, unknown>): Date {
  for (const key of ['ts_event', 'ts']) {
    const value = payload[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      // Seconds, not milliseconds - a value that small would be 1970.
      return new Date(value < 1e12 ? value * 1000 : value)
    }
  }
  for (const key of ['date', 'date_event', 'date_sent']) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) {
      const parsed = new Date(value.replace(' ', 'T'))
      if (!isNaN(parsed.getTime())) return parsed
    }
  }
  // No usable stamp. Now is honest enough, and the row still deduplicates on
  // everything else if the same one arrives twice within the millisecond.
  return new Date()
}

function firstString(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/**
 * One pushed Brevo event, turned into something this module can file.
 *
 * Returns null for anything that is not about a message of ours - which is most
 * of what arrives, because the site's Brevo account also carries order
 * confirmations, purchase orders and password resets, and none of those are
 * conversations.
 */
export function normaliseBrevoEvent(
  body: unknown,
): { messageId: string; event: NormalisedDeliveryEvent } | null {
  if (!body || typeof body !== 'object') return null
  const payload = body as Record<string, unknown>

  const messageId = readCustomTag(payload[CUSTOM_TAG_HEADER] ?? payload['x-mailin-custom'])
  if (!messageId) return null

  const name = typeof payload.event === 'string' ? payload.event.trim().toLowerCase() : ''
  if (!name) return null

  const occurredAt = eventMoment(payload)
  const reason = firstString(payload, ['reason', 'error', 'message'])

  if (name === 'delivered') {
    return { messageId, event: { kind: 'delivered', occurredAt, detail: null, bounceKind: null } }
  }
  // Every flavour of open Brevo has: first open, every open, and the two proxy
  // ones that mean a mail app fetched the picture rather than a person.
  if (name.includes('open')) {
    const proxied = name.includes('proxy')
    return {
      messageId,
      event: {
        kind: proxied ? 'proxy_open' : 'opened',
        occurredAt,
        detail: null,
        bounceKind: null,
      },
    }
  }
  const bounceKind = BOUNCE_KINDS[name]
  if (bounceKind) {
    return { messageId, event: { kind: 'bounced', occurredAt, detail: reason, bounceKind } }
  }
  // Sent, request, click, unsubscribed and anything Brevo adds later. Not an
  // error - just not something this module has an opinion about.
  return null
}

// ---------------------------------------------------------------------------
// Read receipts (RFC 3798)
//
// The other half, and the older one. We ask, in a header, for the recipient's
// mail program to confirm when the message is displayed. Most ignore it,
// several ask the reader first, and Outlook in an office is where it actually
// works. What comes back is an ordinary email with an unusual shape, and it
// must not be filed as an ordinary email: a conversation that reads
//
//   Us: here is the quote
//   Them: Read: here is the quote
//
// looks like the customer replied, and the reply says nothing.
// ---------------------------------------------------------------------------

/** The header asking for one. Standard, and the only one worth sending: the
 *  proprietary alternatives are read by fewer clients and by more spam
 *  filters. */
export const READ_RECEIPT_HEADER = 'Disposition-Notification-To'

export type ReadReceipt = {
  /** The Message-ID of ours this is about, brackets already stripped. */
  originalMessageId: string
  /** Whether it says the message was shown to somebody. A receipt can also say
   *  it was deleted unread, which is a fact worth keeping and not an open. */
  displayed: boolean
  /** What the receipt said, for the record. */
  detail: string | null
}

function stripBrackets(value: string): string {
  return value.trim().replace(/^<|>$/g, '')
}

/**
 * A read receipt out of an arriving message, or null if it is not one.
 *
 * Everything it needs is passed in rather than parsed here, so the caller keeps
 * the mail parser and this keeps the rules.
 */
export function readReadReceipt(input: {
  contentType: string | null
  /** Every part of the message worth reading as text - the plain body and any
   *  disposition-notification part. */
  parts: string[]
  inReplyTo: string | null
  references: string[]
}): ReadReceipt | null {
  const contentType = (input.contentType ?? '').toLowerCase()
  const isReport =
    contentType.includes('multipart/report') && contentType.includes('disposition-notification')
  const hasNotificationPart = input.parts.some((part) => /^\s*(final|original)-recipient\s*:/im.test(part))
  if (!isReport && !hasNotificationPart) return null

  let originalMessageId: string | null = null
  let disposition: string | null = null
  for (const part of input.parts) {
    const idMatch = part.match(/^\s*original-message-id\s*:\s*(.+)$/im)
    if (idMatch?.[1] && !originalMessageId) originalMessageId = stripBrackets(idMatch[1])
    const dispositionMatch = part.match(/^\s*disposition\s*:\s*(.+)$/im)
    if (dispositionMatch?.[1] && !disposition) disposition = dispositionMatch[1].trim()
  }

  // A receipt that names no original still threads: it is a reply to the
  // message it is about, and the headers say so.
  originalMessageId =
    originalMessageId ||
    (input.inReplyTo ? stripBrackets(input.inReplyTo) : null) ||
    (input.references.length ? stripBrackets(input.references[input.references.length - 1]!) : null)

  if (!originalMessageId) return null

  const lower = (disposition ?? '').toLowerCase()
  // "displayed" is the one that means somebody saw it. "deleted" on its own
  // means the opposite, and reporting that as read would be worse than
  // reporting nothing.
  const displayed = lower ? lower.includes('displayed') : true

  return {
    originalMessageId,
    displayed,
    detail: disposition
      ? displayed
        ? 'Their mail program confirmed it was opened.'
        : 'Their mail program said it was deleted without being opened.'
      : null,
  }
}
