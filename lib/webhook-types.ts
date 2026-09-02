// The shapes the webhook code passes around. Types only - nothing here imports
// anything with a runtime, so the settings screen can share them.

/** What can fire a webhook. One member today; the column behind it is a list so
 *  that assignment, sending and the rest can join without a schema change. */
export type WebhookEvent = 'message.received'

export const WEBHOOK_EVENTS: WebhookEvent[] = ['message.received']

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
