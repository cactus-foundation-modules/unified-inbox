import { createHash } from 'crypto'

// ---------------------------------------------------------------------------
// What a message IS, and which conversation it belongs to. Kept pure and away
// from both the database and the mail server, because these are the rules that
// decide whether a customer's reply lands on their own conversation or starts a
// rival one, and they need to be testable without either.
//
// Two ideas run through the whole file:
//
//   1. A message's identity is its Message-ID, per mail account. The folder and
//      UID it was found at are just where it happened to be sitting. The same
//      email genuinely exists in INBOX and in Archive, the owner moves mail
//      between folders from their phone, and the copy of our own reply that
//      gets filed into Sent is the reply we already hold. All one message.
//   2. Threading is RFC 5322 first and a heuristic only when the headers give
//      us nothing. Which of the two decided a thread is recorded, so a
//      mis-threaded conversation can be looked at rather than argued about.
// ---------------------------------------------------------------------------

/** `<abc@x>` becomes `abc@x`. Angle brackets are the header's punctuation, not
 *  part of the id, and half the world's mail clients disagree about spacing. */
export function cleanMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim().replace(/^<+/, '').replace(/>+$/, '').trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Every id in a References header, oldest first, as the RFC orders them. */
export function parseReferences(raw: string | string[] | null | undefined): string[] {
  if (!raw) return []
  const text = Array.isArray(raw) ? raw.join(' ') : raw
  const out: string[] = []
  for (const match of text.matchAll(/<([^<>]+)>/g)) {
    const id = cleanMessageId(match[1])
    if (id && !out.includes(id)) out.push(id)
  }
  // A client that writes the ids bare, with no angle brackets at all, is out of
  // spec and still exists. Fall back to whitespace splitting rather than
  // pretending the header was empty.
  if (out.length === 0) {
    for (const part of text.split(/\s+/)) {
      const id = cleanMessageId(part)
      if (id && id.includes('@') && !out.includes(id)) out.push(id)
    }
  }
  return out
}

// Re:, Fwd:, Fw:, and the ones other languages and mailing lists put in front.
// Repeated because a thread that has been round the houses collects several.
const SUBJECT_PREFIX = /^\s*(?:(?:re|aw|sv|vs|antw|fwd?|tr|wg|rv|enc)\s*(?:\[\d+\])?\s*:\s*)/i
const LIST_TAG = /^\s*\[[^\]]{1,40}\]\s*/

/**
 * The comparable form of a subject line: prefixes stripped, list tags dropped,
 * whitespace collapsed, lower case. Used only as a fallback when the headers
 * cannot thread a message, and stored so the fallback is one indexed lookup.
 */
export function normaliseSubject(subject: string | null | undefined): string {
  let text = (subject ?? '').replace(/\s+/g, ' ').trim()
  let changed = true
  while (changed) {
    changed = false
    const withoutPrefix = text.replace(SUBJECT_PREFIX, '')
    if (withoutPrefix !== text) {
      text = withoutPrefix
      changed = true
    }
    const withoutTag = text.replace(LIST_TAG, '')
    if (withoutTag !== text) {
      text = withoutTag
      changed = true
    }
  }
  return text.trim().toLowerCase()
}

/**
 * The identity of a message with no Message-ID of its own - rare, but it
 * happens, and without this every poll would file the same headerless message
 * again. A hash of the things that cannot change: when it was sent, who sent it,
 * and what it was about. Deliberately shaped like an address so nothing
 * downstream has to care which kind of identity it is holding, and suffixed so
 * it can never be mistaken for a real one.
 */
export function contentIdentity(input: {
  sentAt: Date | null
  fromAddress: string | null
  subject: string | null
  sizeBytes?: number | null
}): string {
  const parts = [
    input.sentAt ? input.sentAt.toISOString() : '',
    (input.fromAddress ?? '').toLowerCase(),
    normaliseSubject(input.subject),
    input.sizeBytes == null ? '' : String(input.sizeBytes),
  ]
  const hash = createHash('sha256').update(parts.join(' ')).digest('hex').slice(0, 40)
  return `sha256-${hash}@no-message-id.unified-inbox`
}

/** True for the identities minted above rather than read off a header. */
export function isSyntheticIdentity(id: string | null | undefined): boolean {
  return !!id && id.endsWith('@no-message-id.unified-inbox')
}

export type AutomatedKind = 'auto-reply' | 'bounce' | 'bulk' | 'own-notification'

/**
 * Machinery, not a person (E7). An out-of-office and a bounce both quote our own
 * Message-ID, so both thread perfectly onto the customer's conversation, mark it
 * unread and push it up the list as though the customer had written back. They
 * belong on the thread as a note about what the mail system did, never as a
 * reply from the person.
 */
export function classifyAutomated(headers: {
  autoSubmitted?: string | null
  precedence?: string | null
  contentType?: string | null
  fromAddress?: string | null
  returnPath?: string | null
  listId?: string | null
  subject?: string | null
}): AutomatedKind | null {
  const from = (headers.fromAddress ?? '').toLowerCase()
  const contentType = (headers.contentType ?? '').toLowerCase()
  const returnPath = (headers.returnPath ?? '').trim()

  // A delivery status notification: the report content type is definitive, and
  // the null return path plus a daemon sender covers the servers that send a
  // plain-text bounce instead.
  if (contentType.includes('report-type=delivery-status') || contentType.includes('multipart/report')) return 'bounce'
  if (/^(mailer-daemon|postmaster)@/.test(from)) return 'bounce'
  if (returnPath === '<>' && /delivery|undeliver|returned mail|failure notice/i.test(headers.subject ?? '')) return 'bounce'

  const autoSubmitted = (headers.autoSubmitted ?? '').toLowerCase()
  if (autoSubmitted && autoSubmitted !== 'no') return 'auto-reply'

  const precedence = (headers.precedence ?? '').toLowerCase()
  if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') return 'bulk'
  if (headers.listId) return 'bulk'

  return null
}

export type ThreadCandidate = {
  id: string
  inboxId: string | null
  subjectNormalised: string | null
  lastMessageAt: Date | null
  /** Addresses already seen on that thread, normalised. */
  participants: string[]
}

export type ThreadMatch =
  | { threadId: string; matchedOn: 'in-reply-to' | 'references' | 'heuristic' }
  | { threadId: null; matchedOn: 'new' }

/** How far apart two messages can be and still be judged the same conversation
 *  on subject alone. Long enough for a slow supplier, short enough that next
 *  year's "Invoice" is not last year's. */
export const HEURISTIC_WINDOW_DAYS = 30

/**
 * Which conversation a message joins. Header threading first: the id in
 * In-Reply-To, then anything in References, matched against messages we already
 * hold. Only when neither says anything does the fallback run, and it wants all
 * three of a matching normalised subject, an overlapping participant and a
 * message inside the window - any two of them on their own collect strangers.
 */
export function chooseThread(input: {
  inReplyTo: string | null
  references: string[]
  /** Message-ID to thread id, for every referenced id we hold. */
  byMessageId: Map<string, string>
  subjectNormalised: string
  participants: string[]
  sentAt: Date
  inboxId: string | null
  candidates: ThreadCandidate[]
}): ThreadMatch {
  if (input.inReplyTo) {
    const threadId = input.byMessageId.get(input.inReplyTo)
    if (threadId) return { threadId, matchedOn: 'in-reply-to' }
  }
  // Newest reference first: the nearest ancestor we hold is the better answer
  // when a long thread has been forked.
  for (const reference of [...input.references].reverse()) {
    const threadId = input.byMessageId.get(reference)
    if (threadId) return { threadId, matchedOn: 'references' }
  }

  if (!input.subjectNormalised) return { threadId: null, matchedOn: 'new' }

  const windowMs = HEURISTIC_WINDOW_DAYS * 24 * 60 * 60 * 1000
  const participants = new Set(input.participants.map((p) => p.toLowerCase()))
  let best: { id: string; at: number } | null = null
  for (const candidate of input.candidates) {
    if (candidate.subjectNormalised !== input.subjectNormalised) continue
    if (input.inboxId && candidate.inboxId && candidate.inboxId !== input.inboxId) continue
    const at = candidate.lastMessageAt ? candidate.lastMessageAt.getTime() : 0
    if (!at || Math.abs(input.sentAt.getTime() - at) > windowMs) continue
    if (!candidate.participants.some((p) => participants.has(p.toLowerCase()))) continue
    if (!best || at > best.at) best = { id: candidate.id, at }
  }
  return best ? { threadId: best.id, matchedOn: 'heuristic' } : { threadId: null, matchedOn: 'new' }
}

/** The one-line preview a conversation list shows, so the list never has to
 *  read a body. Quoted history and signature separators are dropped: a reply
 *  whose preview is the message it is replying to tells you nothing. */
export function buildSnippet(text: string | null | undefined, limit = 200): string {
  if (!text) return ''
  const lines: string[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '--') break
    if (line.startsWith('>')) continue
    if (/^on .{10,120}wrote:$/i.test(line)) break
    if (/^-{3,}\s*original message\s*-{3,}$/i.test(line)) break
    if (!line) continue
    lines.push(line)
    if (lines.join(' ').length >= limit) break
  }
  const joined = lines.join(' ').replace(/\s+/g, ' ').trim()
  return joined.length > limit ? `${joined.slice(0, limit - 1).trimEnd()}…` : joined
}
