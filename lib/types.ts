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
  attachmentFetch: AttachmentFetchMode
  autoLink: boolean
  defaultInboxId: string | null
}
