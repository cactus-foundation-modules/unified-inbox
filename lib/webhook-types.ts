// The shapes the webhook code passes around. Types only - nothing here imports
// anything with a runtime, so the settings screen can share them.

/** What can fire a webhook. The column behind it is a list, so each of these
 *  joined without a schema change.
 *
 *  message.received     - post from outside landed in the inbox.
 *  discussion.received  - a colleague wrote in an internal discussion that is
 *                         put to, or filed in, the inbox (see lib/colleague-webhooks.ts).
 *  mention.received     - a colleague asked somebody to look at a conversation,
 *                         an email one or a discussion.
 *  conversation.assigned - a colleague handed a conversation to somebody. */
export type WebhookEvent =
  | 'message.received'
  | 'discussion.received'
  | 'mention.received'
  | 'conversation.assigned'

export const WEBHOOK_EVENTS: WebhookEvent[] = [
  'message.received',
  'discussion.received',
  'mention.received',
  'conversation.assigned',
]

/** Where a subscription's signing password, or its extra headers, come from.
 *
 *  'shared' is the site-wide pair, read at the moment of each delivery, so
 *  rotating a key is one edit rather than one per subscription. 'own' is the
 *  subscription's own. 'none' is neither. */
export type CredentialSource = 'shared' | 'own' | 'none'

export const CREDENTIAL_SOURCES: CredentialSource[] = ['shared', 'own', 'none']

export type Webhook = {
  id: string
  name: string
  /** null means every inbox, including ones added later. */
  inboxId: string | null
  url: string
  enabled: boolean
  events: WebhookEvent[]
  payloadStyle: 'event' | 'literal'
  literalBody: string | null
  includeBody: boolean
  /** Minutes after queueing a note during which nothing else is sent to this
   *  subscription at all. 0 is off. See migrations/058_webhook_quiet_period.sql. */
  quietMinutes: number
  /** Whether this subscription has one of its OWN stored - which is a different
   *  question from whether a delivery will carry one. See the source below. */
  hasSecret: boolean
  hasHeaders: boolean
  secretSource: CredentialSource
  headersSource: CredentialSource
  lastStatus: string | null
  lastAttemptAt: Date | null
  lastError: string | null
  consecutiveFailures: number
  autoDisabledAt: Date | null
  createdAt: Date
}

export type WebhookInput = {
  name: string
  inboxId?: string | null
  url: string
  enabled?: boolean
  events: WebhookEvent[]
  payloadStyle: 'event' | 'literal'
  literalBody?: string | null
  includeBody?: boolean
  quietMinutes?: number
  secret?: string | null
  headers?: Record<string, string> | null
  secretSource?: CredentialSource
  headersSource?: CredentialSource
}

export type WebhookPatch = Partial<WebhookInput>

/** What the settings screen may know about the shared pair: whether each is
 *  set. Never the values - a signing password that reaches the browser is a
 *  signing password that reaches anybody who can read a network tab. */
export type SharedWebhookState = {
  hasSecret: boolean
  hasHeaders: boolean
}

/** Setting the shared pair. Absent leaves one alone, an empty string clears it,
 *  anything else replaces it - the same three-way shape the per-subscription
 *  fields have always had. */
export type SharedWebhookInput = {
  secret?: string | null
  headers?: Record<string, string> | null
}

export type WebhookSecrets = {
  secret: string | null
  headers: Record<string, string>
}

export type WebhookDelivery = {
  id: string
  webhookId: string
  event: WebhookEvent
  messageId: string | null
  threadId: string | null
  status: 'pending' | 'sent' | 'failed' | 'dead'
  attempts: number
  nextAttemptAt: Date
  responseCode: number | null
  error: string | null
  /** Frozen when the delivery was queued, so a retry hours later sends what was
   *  true when the message arrived rather than what the conversation has since
   *  become. */
  payload: unknown
  createdAt: Date
  deliveredAt: Date | null
}

/** What an 'event' style delivery carries. Identifiers and envelope by default;
 *  the body of the message only when the subscription says so in as many
 *  words. */
export type MessageReceivedPayload = {
  event: 'message.received'
  /** ISO 8601, stamped when the delivery was queued. */
  at: string
  site: string
  inbox: { id: string | null; name: string | null; address: string | null }
  conversation: { id: string; subject: string | null; url: string | null }
  message: {
    id: string
    channel: string
    direction: 'in' | 'out' | 'note'
    from: { name: string | null; address: string | null; phone: string | null }
    subject: string | null
    snippet: string | null
    sentAt: string
    hasAttachments: boolean
    /** Present only when the subscription has "include the message" switched on. */
    bodyText?: string | null
  }
}

/** A colleague a delivery is about, and why. More than one can be true at
 *  once: a discussion put to somebody is also an ask on their own list. */
export type ColleaguePerson = {
  id: string
  name: string | null
  email: string | null
  /** On the discussion's To line, or the one who started it. */
  addressed: boolean
  /** Tagged in this note. */
  mentioned: boolean
  /** Handed the conversation. */
  assigned: boolean
}

/** What an 'event' style delivery carries for something a colleague did - the
 *  envelope of a message, plus who did it and who it is for.
 *
 *  For a note, the message is the note. For a hand-over, it is the newest
 *  message on the conversation that is not a note: the post being handed over,
 *  with its own sender. */
export type ColleaguePayload = Omit<MessageReceivedPayload, 'event'> & {
  event: 'discussion.received' | 'mention.received' | 'conversation.assigned'
  /** Whoever wrote the note or handed the conversation over. */
  by: { id: string; name: string | null; email: string | null }
  /** The colleagues this delivery is about. On a subscription to one person's
   *  own inbox, that person and nobody else. */
  for: ColleaguePerson[]
}
