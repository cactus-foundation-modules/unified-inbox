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
  signatureHtml: string | null
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
