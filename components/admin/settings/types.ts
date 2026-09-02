// The shapes the Unified Inbox settings screen works in.
//
// They live in a file of their own because six panels share them and each of
// those panels is now a file of its own. Nothing in here does anything - it is
// the vocabulary the rest of the folder is written in.

export type MailFolder = { path: string; name: string; role: string | null }

export type Connection = {
  id: string
  label: string
  imapHost: string
  imapPort: number
  imapUsername: string
  hasPassword: boolean
  imapTls: boolean
  extraFolders: string[]
  foldersOnly: boolean
  discardUnrouted: boolean
  /** What this account's mail server last said its folders were called, or null
   *  if nobody has asked it yet. Kept on the account rather than fetched when a
   *  form opens: listing folders means opening somebody's mailbox, which is not
   *  a thing to do on a page load. */
  discoveredFolders: MailFolder[] | null
  foldersCheckedAt: string | null
  lastSyncAt: string | null
  lastSyncStatus: 'ok' | 'error' | null
  lastSyncError: string | null
}

export type SignatureKind = 'markdown' | 'html' | 'puck'

export type Inbox = {
  id: string
  name: string
  address: string
  connectionId: string | null
  imapFolder: string
  sentFolder: string | null
  isCatchAll: boolean
  sendTransport: 'brevo' | 'smtp'
  hasBrevoKey: boolean
  smtpHost: string | null
  smtpPort: number | null
  smtpUsername: string | null
  hasSmtpPassword: boolean
  fromName: string | null
  signatureKind: SignatureKind
  signature: string | null
  signatureHtml: string | null
  signaturePuck: unknown
  appendToSent: boolean
  /** Reserved. Stored and validated, but nothing on any screen sets it yet -
   *  it is here for the day inboxes are colour-coded in the list. */
  colour: string | null
  sortOrder: number
}

export type AccessRow = { inboxId: string; userId: string; canReply: boolean }

export type Settings = {
  backfillMonths: number
  retentionMonths: number | null
  retentionKeepLinked: boolean
  retentionLastRunAt: string | null
  attachmentFetch: 'lazy' | 'always' | 'never'
  autoLink: boolean
  newestFirst: boolean
  defaultInboxId: string | null
  ownDomains: string[] | null
  personalDomains: string[]
  orderNumberPattern: string | null
  poNumberPattern: string | null
  quoteNumberPattern: string | null
  trackOpens: boolean
  requestReadReceipts: boolean
}

export type StaffMember = { id: string; name: string; email: string }

export type CollectionStat = {
  connectionId: string
  folders: number
  collected: number
  estimated: number | null
  backfillComplete: boolean
  lastRunAt: string | null
  lastError: string | null
}

export type RetentionForecast = { cutoff: string; due: number; keptForLinks: number }

export type Payload = {
  connections: Connection[]
  inboxes: Inbox[]
  access: AccessRow[]
  settings: Settings
  collection: CollectionStat[]
  unrouted: number
  /** Mailboxes something else on this site is already watching, and what to do
   *  about it. One per mail account, never more. */
  warnings: Array<{ connectionId: string; message: string }>
  people: { people: number; organisations: number }
  /** What the window would remove on its next pass, and what is being held back
   *  only because it is attached to one of the site's own records. Null when no
   *  window is set, which is where every site starts. */
  retention: RetentionForecast | null
  users: StaffMember[]
  encryptionReady: boolean
}

/** Something to tell the person at the screen, and whether it is good news.
 *  Success and failure used to be the same grey box, so "Connected. Found 5
 *  folders." and "That did not work." looked identical. */
export type Note = { tone: 'ok' | 'bad'; text: string }

/** Send something to the settings API, say how it went, and reload. Every panel
 *  is handed the same one, so a save made anywhere refreshes the screen
 *  everywhere. */
export type Caller = (path: string, init: RequestInit, okText?: string | null) => Promise<unknown | null>

/** Which panel of the settings screen is open. Rides in the URL as `?sub=`, so
 *  a refresh or a pasted link comes back to it. */
export type SubTab =
  | 'overview'
  | 'accounts'
  | 'inboxes'
  | 'collecting'
  | 'receipts'
  | 'people'
  | 'webhooks'

export const SUB_TABS: ReadonlyArray<{ key: SubTab; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'accounts', label: 'Mail accounts' },
  { key: 'inboxes', label: 'Inboxes' },
  { key: 'collecting', label: 'Collecting' },
  { key: 'receipts', label: 'Sent replies' },
  { key: 'people', label: 'People' },
  { key: 'webhooks', label: 'Other apps' },
]
