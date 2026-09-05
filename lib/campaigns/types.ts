// Shapes the campaign half of the module shares. Rows come back from raw SQL as
// snake_case records and are mapped into these in lib/campaigns/store.ts, so
// nothing outside that file ever handles a raw column name - the same bargain
// lib/db.ts strikes for the rest of the hub.

export type CampaignStatus = 'draft' | 'running' | 'paused' | 'done' | 'stopped'

export const CAMPAIGN_STATUSES: readonly CampaignStatus[] = [
  'draft', 'running', 'paused', 'done', 'stopped',
]

/** Why a campaign is not running. A person's decision, or something to fix. */
export type CampaignPauseKind = 'manual' | 'bounces' | 'provider' | 'address-gone'

/** Where one person on one campaign has got to. See migration 027 for what each
 *  one means and why 'complained' is kept apart from 'unsubscribed'. */
export type RecipientState =
  | 'queued'
  | 'sending'
  | 'replied'
  | 'unsubscribed'
  | 'bounced'
  | 'complained'
  | 'failed'
  | 'skipped'
  | 'done'

export const RECIPIENT_STATES: readonly RecipientState[] = [
  'queued', 'sending', 'replied', 'unsubscribed', 'bounced',
  'complained', 'failed', 'skipped', 'done',
]

/** States nothing further will ever be sent from. The runner never claims one,
 *  and the progress bar counts them as finished with. */
export const SETTLED_STATES: readonly RecipientState[] = [
  'replied', 'unsubscribed', 'bounced', 'complained', 'failed', 'skipped', 'done',
]

export type SuppressionReason = 'unsubscribed' | 'bounced' | 'complained' | 'manual'

export const SUPPRESSION_REASONS: readonly SuppressionReason[] = [
  'unsubscribed', 'bounced', 'complained', 'manual',
]

/**
 * When a campaign may send, in the site's own timezone.
 *
 * Split out from the campaign itself because every piece of maths worth testing
 * takes exactly this and nothing else - and because the runner, the forecast on
 * the screen and the "when does the next one go" line all have to agree, which
 * they only do by sharing one shape and one set of functions.
 */
export type SendWindow = {
  /** Minutes past midnight, site time. 480 is 08:00. */
  startMinute: number
  endMinute: number
  weekdaysOnly: boolean
  /** Calendar dates to sit out, "YYYY-MM-DD" in site time. */
  skipDates: readonly string[]
  intervalSeconds: number
  jitterSeconds: number
  dailyCap: number | null
  rampEnabled: boolean
  rampStart: number
}

export type Campaign = {
  id: string
  name: string
  /** Null once somebody has deleted the address it sent from. */
  inboxId: string | null
  status: CampaignStatus
  pauseKind: CampaignPauseKind | null
  pauseReason: string | null
  includeSignature: boolean
  includeUnsubscribe: boolean
  copyToSent: boolean
  startAt: Date | null
  window: SendWindow
  excludeColleagues: boolean
  /** The labels it was built from, so "top up" has something to ask. */
  categoryIds: string[]
  createdBy: string | null
  /** When somebody last sent themselves a test of it. Null means nobody has,
   *  which is what stops it being started. */
  testedAt: Date | null
  createdAt: Date
  updatedAt: Date
  startedAt: Date | null
  finishedAt: Date | null
}

/** The message, or one of the chases after it. Step 0 is the message. */
export type CampaignStep = {
  id: string
  campaignId: string
  stepIndex: number
  /** Days after the step before it. Null on step 0. */
  waitDays: number | null
  /** Null on a chase, which means "Re: whatever step 0 said". */
  subject: string | null
  body: string
}

export type CampaignRecipient = {
  id: string
  campaignId: string
  personId: string | null
  address: string
  firstName: string | null
  lastName: string | null
  displayName: string | null
  organisationName: string | null
  state: RecipientState
  stepIndex: number
  dueAt: Date | null
  claimedAt: Date | null
  firstMessageId: string | null
  lastMessageId: string | null
  firstSubject: string | null
  lastSentAt: Date | null
  repliedAt: Date | null
  unsubscribedAt: Date | null
  bouncedAt: Date | null
  reason: string | null
}

/** One message that actually left, and what became of it. */
export type CampaignSend = {
  id: string
  campaignId: string
  recipientId: string
  stepIndex: number
  address: string
  status: 'sending' | 'sent' | 'failed'
  error: string | null
  messageId: string | null
  providerMessageId: string | null
  sentAt: Date | null
  deliveredAt: Date | null
  openedAt: Date | null
  bouncedAt: Date | null
  bounceKind: string | null
  bounceDetail: string | null
}

export type Suppression = {
  id: string
  address: string
  reason: SuppressionReason
  campaignId: string | null
  note: string | null
  createdAt: Date
}

/** What the progress bar and the Watch tab count. One query, every state. */
export type CampaignTally = Record<RecipientState, number> & { total: number }

/** The name fields a message is personalised from. Copied onto the recipient
 *  row when the list is built, never read back through to the address book -
 *  see migration 027 for why. */
export type RecipientNames = {
  firstName: string | null
  lastName: string | null
  displayName: string | null
  organisationName: string | null
  address: string
}
