// ---------------------------------------------------------------------------
// Reading a bounce: which of our messages it is about, and how bad it is.
//
// Mail sent through an ordinary mail account over SMTP has nobody reporting
// back on it. The mail server takes it, and the only news that ever follows is
// bad news: a delivery report (RFC 3464) sent back to the sending mailbox, saying
// the far end would not take it - or, sometimes, that it is still trying. When
// that mailbox is one this module collects, the report arrives like any other
// email, and sync.ts already knows it is a bounce rather than a person (see
// classifyAutomated). This works out what it is ABOUT, so the "Sent" under our
// reply can turn into "It did not arrive".
//
// Pure: handed the parts of the message worth reading as text, it hands back a
// verdict. The caller keeps the mail parser.
//
// The report names the original in one of three places, and all three are
// read, because different mail servers fill in different ones: the headers of
// the original message, quoted in a text/rfc822-headers or message/rfc822 part;
// the In-Reply-To and References of the report itself; and, rarely, an
// X-Original-Message-ID line.
// ---------------------------------------------------------------------------

export type BounceReading = {
  /** Every Message-ID the report says it is about, brackets off. */
  originalMessageIds: string[]
  /** 'hard' - it will not arrive. 'soft' - the far end is still trying. */
  kind: 'hard' | 'soft'
  /** A sentence for the history screen, with what the far end said after it. */
  detail: string | null
}

function stripBrackets(value: string): string {
  return value.trim().replace(/^<|>$/g, '').trim()
}

/** Message-IDs quoted in a block of headers. Only whole header lines, so a
 *  Message-ID mentioned in the prose of a report is not mistaken for one. */
function quotedMessageIds(part: string): string[] {
  const out: string[] = []
  const re = /^(?:x-original-)?message-id\s*:\s*(<[^>\s]+>|[^\s<>]+@[^\s<>]+)\s*$/gim
  for (const match of part.matchAll(re)) {
    const id = stripBrackets(match[1] ?? '')
    if (id && id.length <= 998) out.push(id)
  }
  return out
}

function field(parts: string[], name: string): string | null {
  const re = new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, 'im')
  for (const part of parts) {
    const match = re.exec(part)
    if (match?.[1]) return match[1].trim()
  }
  return null
}

/** What a status code means, in words a site owner can use. */
function plainStatus(status: string | null, kind: 'hard' | 'soft'): string {
  if (kind === 'soft') return 'Their mail server has not taken it yet and is still trying.'
  if (!status) return 'Their mail server would not take it.'
  if (/^5\.1\.(?:0|1|3|10)\b/.test(status)) return 'That address does not exist at their end.'
  if (/^5\.1\.2\b/.test(status)) return 'Their email domain could not be found.'
  if (/^5\.2\.2\b/.test(status)) return 'Their mailbox is full.'
  if (/^5\.2\.1\b/.test(status)) return 'Their mailbox is switched off.'
  if (/^5\.7\./.test(status)) return 'Their mail server refused it as unwanted or not allowed.'
  if (/^5\.3\.4\b/.test(status)) return 'It was too big for their mail server.'
  return 'Their mail server would not take it.'
}

/**
 * The verdict on one arriving message, or null when it is not a bounce we can
 * use: not a report at all, a report of SUCCESSFUL delivery (some servers send
 * those on request), or one that never says which message it is about.
 */
export function readBounce(input: {
  /** The report's own Content-Type header. */
  contentType: string | null
  /** The plain body and every report part, as text. */
  parts: string[]
  inReplyTo: string | null
  references: string[]
  subject: string | null
}): BounceReading | null {
  const action = (field(input.parts, 'action') ?? '').toLowerCase()
  const status = field(input.parts, 'status')?.match(/[245]\.\d{1,3}\.\d{1,3}/)?.[0] ?? null
  const diagnostic = field(input.parts, 'diagnostic-code')

  // A report that says it arrived is not a bounce, whatever else it is.
  if (/^(delivered|relayed|expanded)\b/.test(action)) return null
  if (status?.startsWith('2.')) return null

  let kind: 'hard' | 'soft'
  if (action.startsWith('delayed') || status?.startsWith('4.')) kind = 'soft'
  else if (action.startsWith('failed') || status?.startsWith('5.')) kind = 'hard'
  else if (/\b(delay(ed)?|will (be )?retr(y|ied)|still trying|temporar)/i.test(input.subject ?? '')) kind = 'soft'
  else kind = 'hard'

  const ids = new Set<string>()
  for (const part of input.parts) for (const id of quotedMessageIds(part)) ids.add(id)
  if (input.inReplyTo) ids.add(stripBrackets(input.inReplyTo))
  for (const reference of input.references) {
    const id = stripBrackets(reference)
    if (id) ids.add(id)
  }
  if (ids.size === 0) return null

  const said = diagnostic ? diagnostic.replace(/^\s*smtp\s*;\s*/i, '').replace(/\s+/g, ' ').slice(0, 300) : null
  const plain = plainStatus(status, kind)
  return {
    originalMessageIds: [...ids],
    kind,
    detail: said ? `${plain} Their server said: ${said}` : plain,
  }
}
