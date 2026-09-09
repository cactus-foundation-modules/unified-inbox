import { cleanMessageId } from './threading'

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
//
//   A click is the same story one step along, and it only exists at all when
//   the mail service is rewriting the links in the message so it can see them
//   being followed. It is the strongest ordinary signal there is - somebody
//   went somewhere - and it is still not proof of a person: an office security
//   scanner opens every link in an arriving email to check where it goes, and
//   it does them all at once. Which is why the WHICH LINK is kept rather than
//   only a count, and why several links inside the same second are filed as
//   several clicks rather than collapsing into one.
//
//   Half the sent mail on the screen never carried our tag. A reply somebody
//   typed goes out through this module and leaves with the tag on it; an order
//   confirmation does not, because the shop sent that one and this module was
//   handed a copy afterwards, by which time the email was already with the
//   customer (see outbound-record.ts). There is no header to add at that point
//   and never will be - so the only handle those have is the name the sending
//   service gave the message, which is stored on the row and comes back on
//   every event about it. Hence two identifiers out of here rather than one:
//   the tag where there is one, the service's own id where there is not.
// ---------------------------------------------------------------------------

/** The strongest thing we know about a message, in the order it is worth. */
export type DeliveryEventKind = 'delivered' | 'opened' | 'proxy_open' | 'clicked' | 'bounced' | 'receipt'

export type NormalisedDeliveryEvent = {
  kind: DeliveryEventKind
  occurredAt: Date
  /** A sentence for a person: the bounce reason, mostly, and the address that
   *  was followed on a click. */
  detail: string | null
  /** 'hard' | 'soft' | 'blocked' | 'spam' | 'invalid' | 'deferred' | 'error',
   *  and null for anything that is not a failure. */
  bounceKind: string | null
}

/** The events we ask Brevo to send us, in the spelling its subscription API
 *  wants. Deliberately short: a deferral is the mail service talking to itself
 *  about a retry it is about to make anyway, and an unsubscribe belongs to the
 *  campaign half of the module rather than to a reply.
 *
 *  `click` only ever arrives if link tracking is switched on in the Brevo
 *  account itself - the service has to be rewriting the addresses in the
 *  message to know one was followed. Subscribing to it when it is off costs
 *  nothing and reports nothing, which is why there is no switch for it here. */
export const BREVO_SUBSCRIBED_EVENTS = [
  'delivered',
  'opened',
  'uniqueOpened',
  'click',
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
 * The address that was followed, out of a click event.
 *
 * Brevo writes it as `link` on a transactional event and `URL` on a campaign
 * one, and the two halves of this module both go through here. Kept short
 * because it is shown on the screen and stored in a column somebody may one day
 * read with their eyes: a tracking address with four hundred characters of
 * campaign parameters on the end tells nobody anything.
 *
 * Only http and https survive. Anything else in there is not a link that was
 * clicked, and it is about to be put in front of a person.
 */
function clickedLink(payload: Record<string, unknown>): string | null {
  const raw = firstString(payload, ['link', 'URL', 'url'])
  if (!raw) return null
  if (!/^https?:\/\//i.test(raw)) return null
  return raw.slice(0, 500)
}

/** Which of our sent messages an event is about, and what happened to it.
 *
 * One of the two identifiers is always present and either may be missing. The
 * tag is the better of them - it names our row directly, and it survives a
 * service that stamps its own Message-ID over the one we set - but only mail
 * this module sent itself carries it. The service's own id is what is left for
 * everything else, and is exactly what the row for a filed copy stores. */
export type NormalisedBrevoEvent = {
  /** Our own message id, out of the tag that travelled with it. */
  messageId: string | null
  /** What the sending service called the message, brackets already off, so it
   *  compares equal to the `provider_message_id` stored on the row. */
  providerMessageId: string | null
  event: NormalisedDeliveryEvent
}

/** What Brevo calls the message in an event it pushes. `message-id` is the one
 *  it actually sends; the other two are taken because a field name is a cheap
 *  thing to be wrong about and an expensive thing to discover. */
function providerMessageIdOf(payload: Record<string, unknown>): string | null {
  return cleanMessageId(firstString(payload, ['message-id', 'messageId', 'message_id']))
}

/**
 * One pushed Brevo event, turned into something this module can file.
 *
 * Returns null for anything this module has no opinion about, and for anything
 * carrying no way of naming a message at all. It does NOT return null merely
 * because our tag is missing: most of what arrives has no tag, and while most
 * of THAT is a password reset nobody wants filed, some of it is the order
 * confirmation sitting on a conversation in the inbox. Which of the two it is
 * cannot be decided here - it is a question about what is in the database, and
 * everything in this file is pure - so both go back to the caller and the
 * lookup settles it.
 */
export function normaliseBrevoEvent(body: unknown): NormalisedBrevoEvent | null {
  if (!body || typeof body !== 'object') return null
  const payload = body as Record<string, unknown>

  const messageId = readCustomTag(payload[CUSTOM_TAG_HEADER] ?? payload['x-mailin-custom'])
  const providerMessageId = providerMessageIdOf(payload)
  if (!messageId && !providerMessageId) return null

  const name = typeof payload.event === 'string' ? payload.event.trim().toLowerCase() : ''
  if (!name) return null

  const occurredAt = eventMoment(payload)
  const reason = firstString(payload, ['reason', 'error', 'message'])
  const about = (event: NormalisedDeliveryEvent): NormalisedBrevoEvent =>
    ({ messageId, providerMessageId, event })

  if (name === 'delivered') {
    return about({ kind: 'delivered', occurredAt, detail: null, bounceKind: null })
  }
  // Every flavour of open Brevo has: first open, every open, and the two proxy
  // ones that mean a mail app fetched the picture rather than a person.
  if (name.includes('open')) {
    const proxied = name.includes('proxy')
    return about({
      kind: proxied ? 'proxy_open' : 'opened',
      occurredAt,
      detail: null,
      bounceKind: null,
    })
  }
  // Brevo calls it `click` when it pushes one, and `clicks` on some older
  // accounts. Both, for the same reason both spellings of a bounce are taken:
  // finding out in production means a fortnight of filing nothing.
  if (name === 'click' || name === 'clicks') {
    return about({ kind: 'clicked', occurredAt, detail: clickedLink(payload), bounceKind: null })
  }
  const bounceKind = BOUNCE_KINDS[name]
  if (bounceKind) {
    return about({ kind: 'bounced', occurredAt, detail: reason, bounceKind })
  }
  // Sent, request, unsubscribed and anything Brevo adds later. Not an error -
  // just not something this module has an opinion about.
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
