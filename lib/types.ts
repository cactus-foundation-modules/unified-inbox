// Shapes shared across the module. Rows come back from raw SQL as snake_case
// records; every one of them is mapped into one of these before it leaves
// lib/db.ts, so nothing outside that file ever handles a raw column name.

export type SyncStatus = 'ok' | 'error'

export type SendTransport = 'brevo' | 'smtp'

export type AttachmentFetchMode = 'lazy' | 'always' | 'never'

export type ThreadStatus = 'open' | 'snoozed' | 'done'

export type MessageDirection = 'in' | 'out' | 'note'

export type MessageSource = 'imap' | 'brevo' | 'provider' | 'manual'

export type IdentityKind = 'email' | 'phone' | 'chat'

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
  mode: DraftMode
  to: string[]
  cc: string[]
  subject: string | null
  body: string
  attachments: DraftAttachment[]
  createdAt: Date
  updatedAt: Date
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
  connectionId: string | null
  imapFolder: string
  sentFolder: string | null
  isCatchAll: boolean
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

/** One person's place on one inbox's guest list. No rows at all for an inbox
 *  means everybody with `unifiedinbox.view` is on it. */
export type InboxAccess = {
  inboxId: string
  userId: string
  canReply: boolean
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
  /** Whether outgoing replies ask the recipient's own mail program for a read
   *  receipt. Most ignore it; the ones that do not ask the reader first, which
   *  is the honest version of the same question. */
  requestReadReceipts: boolean
}

// ---------------------------------------------------------------------------
// People (S6). Thin on purpose: who somebody is, how to reach them, and which
// organisation their mail domain belongs to. Nothing else - see D15.
// ---------------------------------------------------------------------------

export type Person = {
  id: string
  displayName: string | null
  primaryEmail: string | null
  organisationId: string | null
  organisationName: string | null
  notes: string | null
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

export type Organisation = {
  id: string
  name: string
  domain: string | null
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
