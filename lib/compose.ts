import { nanoid } from 'nanoid'
import { sanitizeEmailHtml } from '@/lib/sanitize'
import { normaliseAddress, addressDomain, isValidAddress } from './addresses'
import { htmlToText } from './html'

// ---------------------------------------------------------------------------
// Building an outgoing message.
//
// Everything in this file is pure: given a thread, a parent message and what
// the person typed, it works out the headers, the recipients and the body, and
// hands them back. Nothing here opens a connection or writes a row, which is
// what makes the awkward parts - who a reply actually goes to, what goes in
// References, whether the attachments will fit - testable without a mail
// server anywhere near them.
//
// The awkward parts are awkward for real reasons, and each one has cost
// somebody something before:
//
//   A reply that ignores Reply-To goes to an address nobody reads, and the
//   customer concludes they were ignored (E13).
//
//   A forward that keeps the original From is this site claiming to send as
//   somebody else's domain. It fails DMARC, and it teaches the receiving
//   servers that mail from this site is worth distrusting (E12).
//
//   An attachment that is quietly dropped for being too big is worse than a
//   refused send, because the person believes they sent the quote (5.2).
// ---------------------------------------------------------------------------

/** How much of a message Brevo will accept, attachments and all. Theirs is
 *  10MB; this leaves room for the headers, the body and base64's overhead so
 *  the refusal happens here, in front of somebody who can do something about
 *  it, rather than as an API error after they pressed Send. */
export const MAX_MESSAGE_BYTES = 9 * 1024 * 1024

/** Core drops a single attachment larger than this rather than losing the
 *  whole email - sensible for an order confirmation, wrong here. We refuse
 *  first, so nothing is ever dropped without the sender being told. Keep this
 *  in step with MAX_ATTACHMENT_BYTES in lib/email/index.ts. */
export const MAX_SINGLE_ATTACHMENT_BYTES = 8 * 1024 * 1024

/** Base64 costs four bytes for every three. Attachments are encoded before
 *  they go, so the ceiling has to be measured against the encoded size or a
 *  9MB pile of files sails past a 10MB limit and is refused at the far end. */
export function encodedSize(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

// ---------------------------------------------------------------------------
// Message-ID
// ---------------------------------------------------------------------------

/**
 * Our own Message-ID for an outgoing message.
 *
 * Stored without the angle brackets, because that is how every Message-ID in
 * uin_messages is stored (the sync engine's cleanMessageId strips them on the
 * way in) and the two have to compare equal. The brackets go back on when the
 * header is written.
 *
 * The domain is the sending inbox's own, so the id is plausibly ours to a
 * receiving server and to anybody reading raw headers later.
 */
export function generateMessageId(fromAddress: string): string {
  const domain = addressDomain(normaliseAddress(fromAddress)) ?? 'localhost'
  return `uin.${nanoid(21)}@${domain}`
}

/** A stored Message-ID as it goes into a header. */
export function messageIdHeader(id: string): string {
  return `<${id.replace(/^<|>$/g, '')}>`
}

/** How many ancestors to carry. RFC 5322 wants the chain kept, but a thread
 *  running for a year would grow a header long enough for some servers to
 *  truncate or reject, so the oldest is kept (it is what identifies the
 *  conversation) along with the most recent, which is what clients thread on. */
const MAX_REFERENCES = 20

/**
 * The References chain for a reply: everything the parent referenced, plus the
 * parent itself. Duplicates are dropped, order is oldest first, and the middle
 * is what gets thrown away when it will not fit.
 */
export function buildReferences(parent: {
  messageIdHeader: string | null
  references: string[]
}): string[] {
  const chain: string[] = []
  const seen = new Set<string>()
  for (const ref of [...parent.references, parent.messageIdHeader ?? '']) {
    const clean = ref.replace(/^<|>$/g, '').trim()
    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    chain.push(clean)
  }
  if (chain.length <= MAX_REFERENCES) return chain
  return [chain[0]!, ...chain.slice(chain.length - (MAX_REFERENCES - 1))]
}

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

/** Re: on a reply, but only once however many times the conversation has
 *  turned around. */
export function replySubject(subject: string | null | undefined): string {
  const base = (subject ?? '').trim()
  if (!base) return 'Re: (no subject)'
  // Already an answer to an answer: leave it alone. Stacking "Re: Re: Re:" is
  // what clients that get this wrong look like.
  return /^re\s*:/i.test(base) ? base : `Re: ${base}`
}

export function forwardSubject(subject: string | null | undefined): string {
  const base = (subject ?? '').trim()
  if (!base) return 'Fwd: (no subject)'
  return /^fwd?\s*:/i.test(base) ? base : `Fwd: ${base}`
}

// ---------------------------------------------------------------------------
// Who a reply goes to (E13)
// ---------------------------------------------------------------------------

export type ReplyTarget = {
  /** The message being answered. */
  fromAddress: string | null
  /** Reply-To, when the sender set one. It wins over From - that is the entire
   *  purpose of the header, and a sender who set it did so deliberately. */
  replyTo: string | null
  toAddresses: string[]
  ccAddresses: string[]
}

export type ReplyMode = 'reply' | 'reply-all'

/**
 * Recipients for a reply.
 *
 * Reply-To beats From. Reply-all keeps everybody who was on the original,
 * minus ourselves - answering a message copied to this inbox and putting the
 * inbox back on the Cc is how a mail loop starts.
 */
export function replyRecipients(
  original: ReplyTarget,
  mode: ReplyMode,
  ownAddresses: string[],
): { to: string[]; cc: string[] } {
  const own = new Set(ownAddresses.map(normaliseAddress).filter(Boolean))
  const primary = normaliseAddress(original.replyTo ?? original.fromAddress ?? '')

  const to = primary && isValidAddress(primary) ? [primary] : []
  if (to.length === 0) {
    // Nothing to answer: a message with no usable sender. The caller has to
    // ask for an address rather than send into the dark.
    return { to: [], cc: [] }
  }

  if (mode === 'reply') return { to, cc: [] }

  const seen = new Set(to)
  const cc: string[] = []
  for (const raw of [...original.toAddresses, ...original.ccAddresses]) {
    const address = normaliseAddress(raw)
    if (!address || !isValidAddress(address)) continue
    if (own.has(address) || seen.has(address)) continue
    seen.add(address)
    cc.push(address)
  }
  return { to, cc }
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** "On 3 March 2026 at 14:05, Jane Smith wrote:" - the line every mail client
 *  puts above quoted text, so a customer's own client folds it away. */
export function attributionLine(original: {
  sentAt: Date
  fromName: string | null
  fromAddress: string | null
}): string {
  const when = original.sentAt.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  const who = original.fromName?.trim() || original.fromAddress || 'somebody'
  return `On ${when}, ${who} wrote:`
}

export type QuotedOriginal = {
  sentAt: Date
  fromName: string | null
  fromAddress: string | null
  toAddresses: string[]
  subject: string | null
  bodyText: string | null
  bodyHtml: string | null
}

/** The original, quoted under a reply. Sanitised again on the way out: it is
 *  still third-party markup, and it is about to be sent somewhere with this
 *  site's name on it. */
export function quoteForReply(original: QuotedOriginal): { html: string; text: string } {
  const attribution = attributionLine(original)
  const html = original.bodyHtml
    ? sanitizeEmailHtml(original.bodyHtml)
    : `<p>${escapeHtml(original.bodyText ?? '').replace(/\n/g, '<br />')}</p>`
  const text = original.bodyText ?? (original.bodyHtml ? htmlToText(original.bodyHtml) : '')

  return {
    html: `<p>${escapeHtml(attribution)}</p><blockquote style="margin:0 0 0 0.8em;padding-left:0.8em;border-left:2px solid #ccc">${html}</blockquote>`,
    text: `\n\n${attribution}\n${text.split('\n').map((line) => `> ${line}`).join('\n')}`,
  }
}

/**
 * The original, wrapped for a forward.
 *
 * The headers are reproduced as text inside the body and the message still
 * leaves as this inbox. Putting the original sender in the From line would be
 * this site sending as a domain it does not own, which fails DMARC and costs
 * the site its sending reputation (E12).
 */
export function quoteForForward(original: QuotedOriginal): { html: string; text: string } {
  const rows: Array<[string, string]> = [
    ['From', [original.fromName, original.fromAddress].filter(Boolean).join(' ') || 'unknown'],
    ['Date', original.sentAt.toLocaleString('en-GB')],
    ['Subject', original.subject ?? '(no subject)'],
    ['To', original.toAddresses.join(', ') || 'unknown'],
  ]
  const body = original.bodyHtml
    ? sanitizeEmailHtml(original.bodyHtml)
    : `<p>${escapeHtml(original.bodyText ?? '').replace(/\n/g, '<br />')}</p>`
  const text = original.bodyText ?? (original.bodyHtml ? htmlToText(original.bodyHtml) : '')

  return {
    html:
      `<p>---------- Forwarded message ----------</p>` +
      rows.map(([k, v]) => `<p><strong>${k}:</strong> ${escapeHtml(v)}</p>`).join('') +
      `<div>${body}</div>`,
    text:
      `\n\n---------- Forwarded message ----------\n` +
      rows.map(([k, v]) => `${k}: ${v}`).join('\n') +
      `\n\n${text}`,
  }
}

/** What the person typed, their inbox's signature, and the quoted original,
 *  in that order - which is where every mail client puts them and therefore
 *  where a reader expects to find them. */
export function assembleBody(parts: {
  bodyHtml: string
  signatureHtml: string | null
  quoted: { html: string; text: string } | null
}): { html: string; text: string } {
  const typed = sanitizeEmailHtml(parts.bodyHtml)
  const signature = parts.signatureHtml ? sanitizeEmailHtml(parts.signatureHtml) : ''

  const html = [
    typed,
    signature ? `<div class="uin-signature">${signature}</div>` : '',
    parts.quoted?.html ?? '',
  ]
    .filter(Boolean)
    .join('')

  const text = [
    htmlToText(typed),
    signature ? `\n--\n${htmlToText(signature)}` : '',
    parts.quoted?.text ?? '',
  ]
    .filter(Boolean)
    .join('')

  return { html, text }
}

// ---------------------------------------------------------------------------
// Attachments, and the ceiling that is enforced before anything is sent
// ---------------------------------------------------------------------------

export type OutgoingAttachment = {
  filename: string
  contentType: string | null
  sizeBytes: number
}

export type AttachmentBudget =
  | { ok: true; totalBytes: number }
  | { ok: false; reason: string }

/**
 * Whether this lot will actually go, checked before a row is written or a
 * connection opened.
 *
 * Refusing is the whole point. Core drops an oversized attachment and sends the
 * email anyway, which is right for an order confirmation and quite wrong for a
 * person who has just attached a quote and pressed Send: they would be told the
 * message went, and it would arrive without the quote, and nobody would find
 * out until the customer asked where it was.
 */
export function checkAttachmentBudget(
  attachments: OutgoingAttachment[],
  bodyBytes: number,
): AttachmentBudget {
  let total = bodyBytes
  for (const file of attachments) {
    if (file.sizeBytes > MAX_SINGLE_ATTACHMENT_BYTES) {
      return {
        ok: false,
        reason: `"${file.filename}" is ${describeSize(file.sizeBytes)}, which is too big to email. The limit for one file is ${describeSize(MAX_SINGLE_ATTACHMENT_BYTES)}. Send a link to it instead.`,
      }
    }
    total += encodedSize(file.sizeBytes)
  }
  if (total > MAX_MESSAGE_BYTES) {
    return {
      ok: false,
      reason: `Those attachments come to ${describeSize(total)} once packed for email, and the limit for one message is ${describeSize(MAX_MESSAGE_BYTES)}. Remove one and try again, or send them in two messages.`,
    }
  }
  return { ok: true, totalBytes: total }
}

/** Sizes in the units a person uses, for a message a person has to read. */
export function describeSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes} bytes`
}

// ---------------------------------------------------------------------------
// The headers we emit
// ---------------------------------------------------------------------------

/**
 * Every header this module sets on an outgoing message, and nothing else.
 *
 * Message-ID is the one that matters: it is what a reply arriving in three
 * weeks quotes back at us, it is what the sync engine matches when our own
 * appended copy comes back out of the Sent folder (E11), and core writes it
 * onto the EmailLog row so a person's timeline can find it later.
 */
export function outgoingHeaders(input: {
  messageId: string
  inReplyTo: string | null
  references: string[]
}): Record<string, string> {
  const headers: Record<string, string> = {
    'Message-ID': messageIdHeader(input.messageId),
  }
  if (input.inReplyTo) headers['In-Reply-To'] = messageIdHeader(input.inReplyTo)
  if (input.references.length) {
    headers['References'] = input.references.map(messageIdHeader).join(' ')
  }
  return headers
}
