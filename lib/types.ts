// Shapes shared across the module. Rows come back from raw SQL as snake_case
// records; every one of them is mapped into one of these before it leaves
// lib/db.ts, so nothing outside that file ever handles a raw column name.

import type { ProductRef } from './products/types'

export type SyncStatus = 'ok' | 'error'

export type SendTransport = 'brevo' | 'smtp'

export type AttachmentFetchMode = 'lazy' | 'always' | 'never'

export type ThreadStatus = 'open' | 'snoozed' | 'done'

export type MessageDirection = 'in' | 'out' | 'note'

export type MessageSource = 'imap' | 'brevo' | 'provider' | 'manual'

export type IdentityKind = 'email' | 'phone' | 'chat'

/**
 * Which of the two things an inbox is.
 *
 *   shared     - an address the business owns: sales@, accounts@, hello@. Its
 *                guest list says who may read it, and an empty guest list means
 *                everybody who may open the hub at all.
 *   individual - one person's own post at work. Theirs alone: no colleague and
 *                no administrator opens it. The one place in this module where
 *                holding `unifiedinbox.manage` is not a way past a list.
 */
export type InboxKind = 'individual' | 'shared'

export const INBOX_KINDS: readonly InboxKind[] = ['individual', 'shared']

export function isInboxKind(value: unknown): value is InboxKind {
  return typeof value === 'string' && (INBOX_KINDS as readonly string[]).includes(value)
}

/** How an inbox's signature was written. The same three the contact form
 *  offers, rendered through the same core code, so a site only ever learns one
 *  signature editor. */
export type SignatureKind = 'markdown' | 'html' | 'puck'

export const SIGNATURE_KINDS: readonly SignatureKind[] = ['markdown', 'html', 'puck']

export function isSignatureKind(value: unknown): value is SignatureKind {
  return typeof value === 'string' && (SIGNATURE_KINDS as readonly string[]).includes(value)
}

/** What a half-written message was going to be when it grew up. The same four
 *  the send route accepts, because a draft is only a send that has not happened
 *  yet. */
export type DraftMode = 'new' | 'reply' | 'reply-all' | 'forward'

export const DRAFT_MODES: readonly DraftMode[] = ['new', 'reply', 'reply-all', 'forward']

/** A file travelling with a draft, described by where it already lives in
 *  storage rather than by its bytes - exactly as the send route wants it. */
export type DraftAttachment = {
  key: string
  url: string
  filename: string
  contentType: string | null
  sizeBytes: number | null
}

/** A product on a half-written message. A reference and nothing more - see
 *  migrations/035_draft_products.sql for why nothing a customer reads is stored
 *  alongside it. */
export type DraftProduct = ProductRef

/** A message somebody started and has not sent.
 *
 *  It belongs to its author and to nobody else: a shared inbox has several
 *  people in it, and half-written text is not the team's business until it is
 *  sent. `body` is what was typed, newlines and all, because what goes back
 *  into the box has to be what came out of it. */
export type Draft = {
  id: string
  authorUserId: string
  /** Which address it would leave as, or null while it answers a conversation
   *  another module owns. */
  inboxId: string | null
  /** The conversation being answered, or null for one starting from nothing. */
  threadId: string | null
  /** Which message on that conversation is being answered, when somebody
   *  pressed Reply on one rather than on the conversation. It is what gets
   *  quoted under the reply, so a draft finished tomorrow still quotes the
   *  message it was written against - see migrations/049_draft_in_reply_to.sql.
   *  Null means the newest message, which is what every draft written before
   *  this column meant. */
  inReplyToMessageId: string | null
  mode: DraftMode
  to: string[]
  cc: string[]
  /** The copies nobody else on the message can see. Kept apart from `cc`
   *  rather than merged into it, because that separation IS what a blind copy
   *  is - see migrations/033_bcc.sql. */
  bcc: string[]
  subject: string | null
  body: string
  /** What `body` is written in. 'html' is what both writing boxes save now;
   *  'text' is every draft written before they could hold a typeface, and
   *  every one of those is still opened, printed and sent correctly - see
   *  migrations/034_draft_body_format.sql for why this is a column rather than
   *  a guess at the content. */
  bodyFormat: DraftBodyFormat
  attachments: DraftAttachment[]
  /** The catalogue items it carries, as references. What each one is called and
   *  what it costs are read from the owning module when the message is sent, so
   *  a draft never goes out at a price that has since moved. */
  products: DraftProduct[]
  /** When it should leave on its own, or null for one that goes when somebody
   *  presses Send. */
  sendAt: Date | null
  /** Null for an ordinary draft. See migrations/021_scheduled_send.sql for what
   *  each of the three means. */
  sendState: DraftSendState
  /** Why the last attempt to send it was refused, in a sentence a person can
   *  act on. Only ever set alongside a 'failed' state. */
  sendError: string | null
  /** How long after it goes out to bring the conversation back if nobody has
   *  answered, or null for a message nobody wants chasing. Expressed in minutes
   *  because it is a length of time rather than a moment: the moment is not
   *  known until the message actually leaves. */
  followUpMinutes: number | null
  /** When the conversation should stay asleep until once this message has
   *  actually gone, or null for one nobody asked that of. A moment rather than
   *  a length of time - the opposite of `followUpMinutes` above, and for the
   *  opposite reason: a chase is counted from when the message leaves, whereas
   *  Friday is Friday whichever hour of Monday the message went out. Rides with
   *  `sendAt`: taking the time off takes this off with it. */
  snoozeUntil: Date | null
  /** The conversation whose arrival stood this message down, or null - which is
   *  what it is for all but a handful of drafts. Set when mail turns up from
   *  somebody a scheduled message was addressed to: the time comes off, the
   *  writing stays, and the warning belongs on that conversation. */
  heldByThreadId: string | null
  /** When that happened. */
  heldAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** Which of the two things the body column holds. */
export type DraftBodyFormat = 'text' | 'html'

/** Where a scheduled message has got to. Null is an ordinary draft, which is
 *  what every draft is until somebody puts a time on it. */
export type DraftSendState = 'scheduled' | 'sending' | 'failed' | null

export const DRAFT_SEND_STATES = ['scheduled', 'sending', 'failed'] as const

/** One folder on a mail server, as the server described it. Lives here rather
 *  than beside the IMAP client so the settings screen can name the shape
 *  without dragging a mail library into the browser bundle. */
export type DiscoveredFolder = {
  /** The name to store: what IMAP calls it, delimiters and all. */
  path: string
  /** What it looks like in a mail app. */
  name: string
  /** '\\Sent', '\\Archive', '\\Junk' and friends, where the server says. */
  specialUse: string | null
  /** Our guess at what it is for, used to fill the folder boxes in. */
  role: 'inbox' | 'sent' | 'archive' | 'junk' | 'trash' | 'drafts' | null
}

/** A mail account. The password is never handed out - callers get
 *  `hasPassword` and set a new one if they want it changed. */
export type Connection = {
  id: string
  label: string
  imapHost: string
  imapPort: number
  imapUsername: string
  hasPassword: boolean
  imapTls: boolean
  extraFolders: string[]
  /** Read the nominated folders only, rather than INBOX, the archive and Sent
   *  as well. For an account that carries the owner's own post beside the
   *  site's. */
  foldersOnly: boolean
  /** Do not file mail addressed to none of this site's addresses. Only ever
   *  applied to mail starting a new conversation. */
  discardUnrouted: boolean
  /** What the server said its folders were called, last time anybody asked.
   *  Null means nobody ever has, which the settings screen tells apart from an
   *  account that answered with an empty list. */
  discoveredFolders: DiscoveredFolder[] | null
  /** When that list was taken. */
  foldersCheckedAt: Date | null
  lastSyncAt: Date | null
  lastSyncStatus: SyncStatus | null
  lastSyncError: string | null
  createdAt: Date
  updatedAt: Date
}

/** An address people write to. Secrets follow the same rule as a connection's:
 *  out as booleans, in as replacements. */
export type Inbox = {
  id: string
  name: string
  address: string
  /** Whose post this is: the team's, or one named person's. */
  kind: InboxKind
  /** The person whose own address it is, on an individual inbox. Null on a
   *  shared one, and null on an individual one whose owner's staff account has
   *  since been deleted - at which point only an administrator can see it, the
   *  same answer this module gives for mail it cannot place at all. */
  ownerUserId: string | null
  connectionId: string | null
  imapFolder: string
  sentFolder: string | null
  isCatchAll: boolean
  /** Claim everything found in `imapFolder`, whoever it was addressed to. */
  folderOwnsMail: boolean
  sendTransport: SendTransport
  hasBrevoKey: boolean
  smtpHost: string | null
  smtpPort: number | null
  smtpUsername: string | null
  hasSmtpPassword: boolean
  fromName: string | null
  /** Which of the three below is actually sent. The other two are kept, so
   *  switching back and forth loses nothing. */
  signatureKind: SignatureKind
  /** The rich text kind, stored as markdown. */
  signature: string | null
  /** The pasted kind, sanitised on the way in. */
  signatureHtml: string | null
  /** The block-built kind: Puck data rendered by core's email blocks. */
  signaturePuck: unknown
  appendToSent: boolean
  colour: string | null
  sortOrder: number
  createdAt: Date
  updatedAt: Date
}

/** The two facts that decide who may open an inbox, without the twenty that
 *  do not. Read on its own so the access helpers can settle a whole site's
 *  worth of addresses in one query rather than fetching every signature and
 *  every SMTP setting to answer a yes-or-no question. */
export type InboxAudience = {
  id: string
  kind: InboxKind
  ownerUserId: string | null
}

/** One person's place on one inbox's guest list. No rows at all for an inbox
 *  means everybody with `unifiedinbox.view` is on it. */
export type InboxAccess = {
  inboxId: string
  userId: string
  canReply: boolean
}

/** The address that is one person's own: what they land on, what sits first
 *  along the top of the hub for them, and where their signature is written.
 *  One per person or none, which is why it is keyed on the person rather than
 *  on the pair. */
export type UserDefaultInbox = {
  userId: string
  inboxId: string
}

export type UnifiedInboxSettings = {
  backfillMonths: number
  retentionMonths: number | null
  /** Whether a conversation carrying a link to one of the site's own records -
   *  an order, a purchase order, a quote - survives the retention window. On by
   *  default: somebody who set a twelve month window was thinking about mailing
   *  lists, not about the invoice dispute from eighteen months ago. */
  retentionKeepLinked: boolean
  /** When the sweep last finished a pass. Read only - the sweep sets it. */
  retentionLastRunAt: Date | null
  attachmentFetch: AttachmentFetchMode
  autoLink: boolean
  /** Which end of a conversation opens first. Off - oldest at the top, the way
   *  it happened - unless somebody would rather read the last thing said
   *  without scrolling past everything before it. */
  newestFirst: boolean
  defaultInboxId: string | null
  /** Domains whose senders are colleagues rather than customers (E18). NULL
   *  means "work it out from the addresses this site collects mail on", which
   *  is right for almost everybody; an explicit list, empty included, wins. */
  ownDomains: string[] | null
  /** Free mail providers beyond the ones the module already knows, so a site
   *  whose customers use a regional provider does not gain an organisation per
   *  mailbox host. */
  personalDomains: string[]
  /** What a reference to one of the site's own records looks like. NULL means
   *  the built-in default; an empty string means "do not link this kind". A
   *  pattern only ever proposes - the owning module confirms. */
  orderNumberPattern: string | null
  poNumberPattern: string | null
  quoteNumberPattern: string | null
  /** Whether the mail service is asked to tell us when a reply is delivered,
   *  opened or bounced. Off until somebody switches it on: watching whether a
   *  customer opened an email is tracking, and tracking does not arrive with an
   *  update. */
  trackOpens: boolean
  /** How many seconds to leave between checks for new mail while somebody has
   *  an inbox page open and in front of them. NULL is off, which is the way
   *  every install collects today: the scheduled round, and the button. Never
   *  below the route's own minute of cooldown, because a check that arrives
   *  sooner is turned away rather than served. */
  autoCheckSeconds: number | null
  /** Whether outgoing replies ask the recipient's own mail program for a read
   *  receipt. Most ignore it; the ones that do not ask the reader first, which
   *  is the honest version of the same question. */
  requestReadReceipts: boolean
  /** Whether to show people's own pictures from Gravatar and Libravatar in
   *  place of their initials. Off until somebody switches it on: asking a
   *  third party whether it holds a picture for an address tells that third
   *  party we hold the address, and these are customers' addresses. The
   *  lookup is always made by the server and the picture always served from
   *  this site, so no address, no hash and no reader's IP ever reaches
   *  Gravatar or Libravatar (see lib/avatars.ts). */
  showAvatars: boolean
  /** How many days must pass before any campaign may write to the same address
   *  again. A guard rather than a preference, and site-wide rather than per
   *  campaign for exactly that reason: a rule one campaign can opt out of stops
   *  being a rule. Zero switches it off. */
  campaignCooldownDays: number
  /** How long a finished campaign's send-by-send log is kept. The conversations
   *  it started are ordinary mail and live under the retention window; this is
   *  the ledger behind them. */
  campaignLogMonths: number
  /** Who the campaign mail is from, in the sense the law means: a place, under
   *  the unsubscribe link. Null until somebody fills it in, and a campaign will
   *  not start without it while the footer is switched on. */
  campaignFooterAddress: string | null
  /** Channels the owner has switched off: the module names whose entries are
   *  kept out of the rail, the counts and the lists.
   *
   *  It exists because a channel can now address its conversations at one of
   *  the site's own inboxes. A form that puts every enquiry in sales@ does not
   *  also want a Contact form entry listing the same enquiries a second time -
   *  but a site that has not routed anything very much does, so this is a
   *  decision rather than a rule. Empty is the default and hides nothing.
   *
   *  It hides, it does not discard: the conversations are still collected, so
   *  switching a channel back on brings back everything that arrived while it
   *  was off. An enquiry addressed at no inbox on a hidden channel has nowhere
   *  to be seen in this hub, which is what the setting says in as many words. */
  hiddenChannelModules: string[]
  /** The channel keys, in the order somebody has dragged them into down the
   *  rail. Empty means "the order the modules were found in", which is the
   *  order every install read in before this could be said at all.
   *
   *  Keys naming a channel this site no longer has are kept rather than
   *  dropped: switching a module off and back on again should not lose the
   *  place its channel was put in. Anything installed since is read as coming
   *  after everything named here, so a new channel arrives at the end of the
   *  group rather than in the middle of an order somebody chose. */
  channelOrder: string[]
  /** Whether post arriving at a colleague's own address is handed to that
   *  colleague. On by default, and on for existing sites as well as new ones:
   *  an individual inbox is already one named person's and nobody else's, so a
   *  conversation sitting in one with no name against it was never really
   *  unassigned work - it only counted as some. See lib/own-post.ts for the
   *  four things it checks and what it deliberately leaves alone. */
  autoAssignOwnPost: boolean
}

// ---------------------------------------------------------------------------
// People (S6). Thin on purpose: who somebody is, how to reach them, and which
// organisation their mail domain belongs to. Nothing else - see D15.
// ---------------------------------------------------------------------------

/** Where a record came from: worked out from the post, typed in by hand, or
 *  brought in from a file. Worth knowing - a contact somebody typed is one they
 *  meant, and one the mail pass invented from a From line is a guess. */
export type ContactOrigin = 'mail' | 'hand' | 'import'

export const CONTACT_ORIGINS: readonly ContactOrigin[] = ['mail', 'hand', 'import']

/** A postal address, in the parts a British envelope has. Shared by a person
 *  and an organisation, which have the same one. */
export type PostalAddress = {
  addressLine1: string | null
  addressLine2: string | null
  addressCity: string | null
  addressCounty: string | null
  addressPostcode: string | null
  addressCountry: string | null
}

export type Person = PostalAddress & {
  id: string
  /** The one name everything shows, kept in step with the two boxes below on
   *  every save. Still the fallback for somebody the mail pass met before the
   *  contacts screen existed and whose name has never been split. */
  displayName: string | null
  firstName: string | null
  lastName: string | null
  jobTitle: string | null
  website: string | null
  primaryEmail: string | null
  organisationId: string | null
  organisationName: string | null
  notes: string | null
  origin: ContactOrigin
  /** Set when this person lost a merge. Everything that lists people hides
   *  these, and opening one sends you to whoever they were merged into. */
  mergedIntoId: string | null
  createdAt: Date
  updatedAt: Date
}

export type PersonIdentity = {
  id: string
  personId: string
  kind: IdentityKind
  /** As the sender wrote it, plus tag and all. */
  value: string
  /** What matching compares on: lower cased, plus tag removed. */
  matchValue: string | null
  source: string | null
  createdAt: Date
}

export type Organisation = PostalAddress & {
  id: string
  name: string
  /** What the mail pass matches on. Null for one somebody added by hand: the
   *  haulier who only ever telephones has no mail domain to know. */
  domain: string | null
  email: string | null
  phone: string | null
  website: string | null
  notes: string | null
  origin: ContactOrigin
  createdAt: Date
  updatedAt: Date
}

/**
 * A label somebody puts on a contact: "Supplier", "Trade customer", "Haulier".
 *
 * Not a pipeline and not a stage. Nothing moves between these on its own,
 * nothing else on the site reads them, and a contact can be in several at once
 * because a contact legitimately is several things at once.
 */
export type ContactCategory = {
  id: string
  name: string
  sortOrder: number
  createdAt: Date
  updatedAt: Date
}

/** A link from a conversation or a person to one of the site's own records.
 *  Soft by design: the module that owns the record can be uninstalled. */
export type RecordLink = {
  id: string
  threadId: string | null
  personId: string | null
  moduleName: string
  recordType: string
  recordId: string
  label: string | null
  confidence: number
  linkedBy: 'auto' | 'user'
  createdAt: Date
}
