import { sendEmail, type EmailAttachment, type EmailTransport } from '@/lib/email'
import { tryDecryptSecret } from '@/lib/crypto/secrets'
import { getInboxSecrets } from './db'
import type { Inbox } from './types'

// ---------------------------------------------------------------------------
// Handing a finished message to core.
//
// The one place this module talks to a mail transport, kept in its own file
// because it is where D3 lives: all outbound goes through Brevo, under the
// answering inbox's own identity, through the site's account or the inbox's own
// where one is set.
//
// All three halves of that work. Core's sendEmail takes the headers this module
// needs (S1), the sender identity and the transport for one message (S4), and
// writes an EmailLog row whichever way the message went - which is what lets a
// person's timeline later show the reply a human wrote alongside the mail the
// site sent automatically (D13).
//
// The per-inbox key is decrypted HERE and nowhere else, held only for the
// duration of one send, and never returned to anything that could serialise it.
// ---------------------------------------------------------------------------

export type SendableMessage = {
  to: string[]
  cc: string[]
  /** The inbox answering: the address the message goes out as. */
  from: { name: string | null; address: string }
  /** The inbox's own sending account, or null for the site's. */
  transport: EmailTransport | null
  /** Where answers should go, when that is somewhere other than the sender -
   *  and null when it is not, which for this module is every ordinary message.
   *  See replyToWorthSending: a Reply-To repeating the From address says
   *  nothing and costs a mark on every spam scorer worth checking against. */
  replyTo: string | null
  subject: string
  html: string
  text: string
  headers: Record<string, string>
  attachments: Array<{ filename: string; contentType: string | null; content: Buffer }>
}

export type SendOutcome =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; error: string }

/**
 * The identity a message goes out under (D3).
 *
 * The inbox's own address and display name, which is the entire point: a
 * customer who wrote to hi@ gets an answer from hi@, and a supplier who wrote
 * to marcus@ gets one from marcus@, rather than both getting the same anonymous
 * site address and having to guess who they are talking to.
 *
 * Whichever service actually sends still has to be willing to send as that
 * address - see explainSendError, which is what tells an owner so in English.
 */
export function sendingIdentity(inbox: Inbox): { name: string | null; address: string } {
  return { name: inbox.fromName?.trim() || inbox.name || null, address: inbox.address }
}

/**
 * The Reply-To worth putting on a message, which is none at all when it would
 * only be the From address written out a second time.
 *
 * Every send from this module answers as the inbox and points Reply-To at the
 * inbox, so in practice that is every message: the header said nothing, and a
 * redundant Reply-To is one more small mark against a message on every spam
 * scorer an owner is likely to check their mail against.
 *
 * Core drops it on the way out for the same reason. This exists so that the
 * copy filed in the mailbox's own Sent folder matches what actually left -
 * a Sent copy carrying a header the real message did not is a small lie that
 * somebody eventually debugs.
 */
export function replyToWorthSending(message: Pick<SendableMessage, 'from' | 'replyTo'>): string | null {
  const replyTo = message.replyTo?.trim()
  if (!replyTo) return null
  return replyTo.toLowerCase() === message.from.address.trim().toLowerCase() ? null : replyTo
}

/**
 * The inbox's own sending account, when it has one (D3's per-inbox override).
 *
 * Null means "use the site's", which is what most inboxes on most sites will
 * always want. A stored secret that will not decrypt returns null as well
 * rather than throwing: the encryption key has changed under it, and falling
 * back to the site's account sends the email, where an exception would lose it.
 */
export async function transportForInbox(inbox: Inbox): Promise<EmailTransport | null> {
  if (inbox.sendTransport === 'smtp') {
    if (!inbox.smtpHost) return null
    const { smtpPassword } = await getInboxSecrets(inbox.id)
    const pass = smtpPassword ? tryDecryptSecret(smtpPassword) : null
    return {
      provider: 'smtp',
      host: inbox.smtpHost,
      ...(inbox.smtpPort ? { port: String(inbox.smtpPort) } : {}),
      ...(inbox.smtpUsername ? { user: inbox.smtpUsername } : {}),
      ...(pass ? { pass } : {}),
    }
  }

  if (!inbox.hasBrevoKey) return null
  const { brevoApiKey } = await getInboxSecrets(inbox.id)
  if (!brevoApiKey) return null
  const apiKey = tryDecryptSecret(brevoApiKey)
  return apiKey ? { provider: 'brevo', apiKey } : null
}

/**
 * Sends one message, and never throws.
 *
 * A thrown error here would have to be caught by the caller anyway - the row
 * is already written and has to be settled one way or the other whatever
 * happens - so the failure comes back as a value, already turned into a
 * sentence somebody can act on.
 *
 * Core sends to one recipient per call, so a message with several recipients
 * is several sends. The first failure stops the rest: half a message going out
 * twice is worse than a message that plainly did not go, and the person can
 * press retry once the reason is fixed.
 */
export async function deliver(message: SendableMessage): Promise<SendOutcome> {
  const attachments: EmailAttachment[] = message.attachments.map((file) => ({
    filename: file.filename,
    content: file.content,
    ...(file.contentType ? { contentType: file.contentType } : {}),
  }))

  try {
    await sendEmail({
      to: message.to[0]!,
      from: {
        address: message.from.address,
        ...(message.from.name ? { name: message.from.name } : {}),
      },
      ...(message.transport ? { transport: message.transport } : {}),
      ...(message.to.length > 1 || message.cc.length
        ? { cc: [...message.to.slice(1), ...message.cc] }
        : {}),
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      subject: message.subject,
      html: message.html,
      text: message.text,
      headers: message.headers,
      moduleName: 'unified-inbox',
      ...(attachments.length ? { attachments } : {}),
    })
    // Core records Brevo's own id on the EmailLog row; it does not hand it
    // back from sendEmail. The Message-ID we set is the handle that matters
    // and we already have it.
    return { ok: true, providerMessageId: null }
  } catch (err) {
    return { ok: false, error: explainSendError(err) }
  }
}

/**
 * Plain English for the send failures that actually happen.
 *
 * Brevo's own errors are JSON quoted inside an error string and mean nothing to
 * the person reading them, and "sender not authenticated" in particular is a
 * setup step the owner can fix in ten minutes if anybody tells them what it is
 * (E15, 5.2).
 */
export function explainSendError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const lower = raw.toLowerCase()

  if (lower.includes('sender') && (lower.includes('not valid') || lower.includes('unrecognised') || lower.includes('unrecognized'))) {
    return 'Brevo will not send from that address yet. Whoever looks after the site needs to add it as a verified sender in Brevo, or verify the whole domain, and then it will work.'
  }
  if (lower.includes('email is not configured')) {
    return 'This site has no email account set up yet, so nothing can be sent. Add one in Settings, under Emails.'
  }
  if (lower.includes('unauthorized') || lower.includes('401') || lower.includes('invalid api key')) {
    return 'The email account details were not accepted. The API key may have been changed or removed.'
  }
  if (lower.includes('too large') || lower.includes('413') || lower.includes('payload')) {
    return 'The message was too big to send. Take an attachment off and try again.'
  }
  if (lower.includes('429') || lower.includes('rate limit')) {
    return 'The email service is asking us to slow down. Wait a minute and press retry.'
  }
  if (lower.includes('etimedout') || lower.includes('econnreset') || lower.includes('fetch failed')) {
    return 'The email service could not be reached. It may be a passing wobble - press retry.'
  }
  // Everything else. Whatever the service actually said goes to the log, where
  // somebody who can act on it will see it, and never to the page: it is written
  // for whoever runs the mail service, and the person pressing Send is not them.
  // The same bargain lib/imap.ts strikes with a mail server's own words.
  console.error('[unified-inbox] a send failure with no plain-English form:', raw)
  return 'The message could not be sent, and what the email service said back will not help you. '
    + 'Press retry, and if it keeps happening ask whoever looks after the site to check the email settings.'
}
