import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// ---------------------------------------------------------------------------
// Collecting a mail account when its provider rings, rather than on the hour.
//
// Zoho Mail's outgoing webhooks POST to an address whenever mail lands. That
// POST is treated as a doorbell and nothing more: its body is never read for
// mail, only checked for Zoho's signature, and the account is then read over
// IMAP exactly as a scheduled check would read it. So filing, threading and
// dedupe are the engine's own, and a provider that sends nothing but "something
// changed" works as well as one that sends the whole email.
//
// With the switch on, the hourly job and the admin page's automatic checks
// leave the account alone. Two things still open it:
//   - somebody pressing Check now, which is never second-guessed;
//   - the safety net below, in case the provider stops ringing. Zoho switches
//     a webhook off by itself when the address has been unresponsive "for an
//     extended period", and nothing tells us when it does.
// ---------------------------------------------------------------------------

/** How long a push account may go unchecked before a scheduled round opens it
 *  anyway. Four logins a day instead of twenty-four, and the worst a silently
 *  disabled webhook can cost is a few hours. */
export const PUSH_SAFETY_CHECK_MS = 6 * 60 * 60 * 1000

/** How long a ring that found the account busy keeps waiting for the check in
 *  progress to answer it, and how often it looks. */
export const PUSH_WAIT_POLL_MS = 2_000

/** The slice of clock a ring gets. The route answers the provider at once and
 *  does the work afterwards, inside the same 60 second function. */
export const PUSH_BUDGET_MS = 40_000

/** Times a single check goes back round the folders because another ring came
 *  in while it was reading them. A burst of mail is a handful of rings; a loop
 *  with no end is a provider gone wrong. */
export const PUSH_MAX_ROUNDS = 4

export type ScheduledCandidate = { pushChecks: boolean; lastSyncAt: Date | null }

/** Whether a round nobody asked for - the hourly job or the admin page's own
 *  timer - should open this account. */
export function dueOnSchedule(connection: ScheduledCandidate, now: number = Date.now()): boolean {
  if (!connection.pushChecks) return true
  if (!connection.lastSyncAt) return true
  return now - connection.lastSyncAt.getTime() >= PUSH_SAFETY_CHECK_MS
}

export function mintPushToken(): string {
  return randomBytes(24).toString('hex')
}

/** Tokens are 48 hex characters; anything else is refused before the database
 *  is asked about it. */
export function looksLikePushToken(value: string): boolean {
  return /^[0-9a-f]{48}$/.test(value)
}

export function pushUrl(siteUrl: string, token: string): string {
  return `${siteUrl.replace(/\/$/, '')}/api/m/unified-inbox/webhooks/new-mail?token=${token}`
}

/**
 * Zoho's signature: a base64 HMAC-SHA256 of the raw request body, keyed with
 * the x-hook-secret it sent on its first request. Compared in constant time.
 */
export function hookSignatureMatches(secret: string, body: Buffer, signature: string | null): boolean {
  if (!signature) return false
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('base64'))
  const given = Buffer.from(signature.trim())
  if (expected.length !== given.length) return false
  return timingSafeEqual(expected, given)
}

/** Whether a check that finished having seen `answered` has covered a ring made
 *  at `rang`. */
export function ringAnswered(rang: Date, answered: Date | null): boolean {
  return !!answered && answered.getTime() >= rang.getTime()
}

/** Whether another ring came in while a check was reading the folders. */
export function rangAgain(seen: Date | null, latest: Date | null): boolean {
  if (!latest) return false
  return !seen || latest.getTime() > seen.getTime()
}
