import { normaliseSubject } from './threading'

// ---------------------------------------------------------------------------
// Recognising our own reply when it comes back wearing somebody else's name.
//
// A reply typed in this hub is written as a row and then handed to a sending
// service. Some of those services replace the Message-ID on the way out -
// Brevo's relay stamps its own `@smtp-relay.sendinblue.com` id over ours - so
// the copy that lands back in the mailbox carries an id this module has never
// seen. That happens on every message between two of the site's own addresses,
// where the delivered copy is collected from a folder we read, and it filed the
// reply a second time: the row the send path wrote, and the copy that came
// back, sitting under each other in the conversation saying the same thing.
//
// The Message-ID cannot settle it, so these four things do: who sent it, who it
// went to, what it was about, and when - a copy of a message we sent seconds
// ago, from our own address, to exactly the same people, about exactly the same
// thing. Nothing weaker would do. Matching on subject and sender alone would
// swallow a colleague's genuine second reply, which is a message the owner
// wrote and would never see again.
// ---------------------------------------------------------------------------

export type OutboundCandidate = {
  id: string
  threadId: string
  messageIdHeader: string | null
  toAddresses: string[]
  ccAddresses: string[]
  subject: string | null
  sentAt: Date
}

/**
 * How far apart the two copies may be.
 *
 * The row is stamped when the service accepts the message and the delivered
 * copy carries whatever time the service put on it, so they are seconds apart
 * in the ordinary case and further apart when a relay is queueing. Two minutes
 * is comfortably past the slow case and nowhere near long enough to reach a
 * second reply somebody typed by hand.
 */
export const RELAY_COPY_WINDOW_MS = 120_000

/** The same set of addresses, in any order, however they were capitalised. */
function sameAddresses(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const left = [...new Set(a.map((x) => x.toLowerCase()))].sort()
  const right = [...new Set(b.map((x) => x.toLowerCase()))].sort()
  return left.length === right.length && left.every((x, i) => x === right[i])
}

/**
 * Which of the outbound messages we already hold this delivered copy is.
 *
 * Candidates are rows the send path wrote that have never been located in a
 * mailbox - each copy claims one, so a conversation with two replies a minute
 * apart pairs them off rather than folding both onto one. Null means this is
 * not one of ours and should be filed as the new message it appears to be.
 */
export function chooseRelayCopy(
  candidates: OutboundCandidate[],
  incoming: { toAddresses: string[]; ccAddresses: string[]; subject: string | null; sentAt: Date },
): OutboundCandidate | null {
  const subject = normaliseSubject(incoming.subject)
  const matches = candidates.filter(
    (candidate) =>
      normaliseSubject(candidate.subject) === subject &&
      sameAddresses(candidate.toAddresses, incoming.toAddresses) &&
      sameAddresses(candidate.ccAddresses, incoming.ccAddresses) &&
      Math.abs(candidate.sentAt.getTime() - incoming.sentAt.getTime()) <= RELAY_COPY_WINDOW_MS,
  )
  if (matches.length === 0) return null

  return matches.reduce((closest, candidate) =>
    Math.abs(candidate.sentAt.getTime() - incoming.sentAt.getTime()) <
    Math.abs(closest.sentAt.getTime() - incoming.sentAt.getTime())
      ? candidate
      : closest,
  )
}
