import { randomBytes } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { encryptSecret, tryDecryptSecret } from '@/lib/crypto/secrets'
import { normaliseAddress } from './addresses'
import { remoteImageUrls } from './remote-images'
import { DRAFT_MODES, isSignatureKind } from './types'
import type {
  AttachmentFetchMode,
  Connection,
  DiscoveredFolder,
  Draft,
  DraftAttachment,
  DraftMode,
  IdentityKind,
  Inbox,
  InboxAccess,
  UserDefaultInbox,
  Organisation,
  Person,
  PersonIdentity,
  RecordLink,
  SendTransport,
  SignatureKind,
  SyncStatus,
  UnifiedInboxSettings,
} from './types'

// ---------------------------------------------------------------------------
// Every read and write against the uin_ tables goes through here, so the raw
// column names live in exactly one file. Secrets go in as plaintext and come
// back as booleans - a decrypted password has no business leaving the server,
// and the settings screen only ever needs to know whether one is set.
//
// S2 owns the tables the settings screen configures: connections, inboxes,
// their access lists and the module's own settings row. Threads, messages,
// people and the sync ledger have their schema but no helpers yet - the sync
// engine (S3) writes those, and guessing its shape now would only mean writing
// it twice.
// ---------------------------------------------------------------------------

/** A JSONB value for a raw query, or a real NULL. Kept apart because "no
 * signature was ever built" and "a signature made of the JSON literal null"
 * are different rows, and only the first one is what an empty editor means. */
function jsonOrNull(value: unknown): Prisma.Sql {
  return value === null || value === undefined
    ? Prisma.sql`NULL`
    : Prisma.sql`${JSON.stringify(value)}::jsonb`
}

function optionalSecret(value: string | null | undefined): string | null | undefined {
  // undefined = "leave whatever is there alone", '' = "clear it", anything
  // else = "replace it". Encrypting an empty string would store a perfectly
  // valid encryption of nothing, which then reads back as "a password is set".
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  return encryptSecret(value)
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

const FOLDER_ROLES = ['inbox', 'sent', 'archive', 'junk', 'trash', 'drafts'] as const

/** The stored folder list, checked on the way out. It is our own write, but it
 *  is a JSONB column all the same: a row written by an older version of this
 *  module, or restored from a backup taken from one, has to come back as either
 *  a well-formed list or nothing. Half a list would reach the settings screen
 *  as a menu with holes in it. */
function parseDiscoveredFolders(value: unknown): DiscoveredFolder[] | null {
  if (!Array.isArray(value)) return null
  const folders: DiscoveredFolder[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null
    const row = entry as Record<string, unknown>
    if (typeof row.path !== 'string' || typeof row.name !== 'string') return null
    const specialUse = typeof row.specialUse === 'string' ? row.specialUse : null
    const role = FOLDER_ROLES.find((r) => r === row.role) ?? null
    folders.push({ path: row.path, name: row.name, specialUse, role })
  }
  return folders
}

function mapConnection(r: Record<string, unknown>): Connection {
  return {
    id: r.id as string,
    label: r.label as string,
    imapHost: r.imap_host as string,
    imapPort: Number(r.imap_port ?? 993),
    imapUsername: r.imap_username as string,
    hasPassword: !!r.imap_password_encrypted,
    imapTls: !!r.imap_tls,
    extraFolders: (r.extra_folders as string[] | null) ?? [],
    foldersOnly: !!r.folders_only,
    discardUnrouted: !!r.discard_unrouted,
    discoveredFolders: parseDiscoveredFolders(r.discovered_folders),
    foldersCheckedAt: (r.folders_checked_at as Date | null) ?? null,
    lastSyncAt: (r.last_sync_at as Date | null) ?? null,
    lastSyncStatus: (r.last_sync_status as SyncStatus | null) ?? null,
    lastSyncError: (r.last_sync_error as string | null) ?? null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  }
}

export async function listConnections(): Promise<Connection[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_connections" ORDER BY "label" ASC
  `
  return rows.map(mapConnection)
}

export async function getConnection(id: string): Promise<Connection | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_connections" WHERE "id" = ${id}
  `
  return rows[0] ? mapConnection(rows[0]) : null
}

/** The decrypted credentials, for the sync engine and the Test connection
 *  button only. Never return this to a browser. */
export async function getConnectionSecret(id: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ imap_password_encrypted: string | null }[]>`
    SELECT "imap_password_encrypted" FROM "uin_connections" WHERE "id" = ${id}
  `
  return rows[0]?.imap_password_encrypted ?? null
}

export async function createConnection(data: {
  label: string
  imapHost: string
  imapPort: number
  imapUsername: string
  imapPassword: string
  imapTls?: boolean
  extraFolders?: string[]
  foldersOnly?: boolean
  discardUnrouted?: boolean
}): Promise<Connection> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    INSERT INTO "uin_connections"
      ("label", "imap_host", "imap_port", "imap_username", "imap_password_encrypted", "imap_tls", "extra_folders",
       "folders_only", "discard_unrouted")
    VALUES (${data.label}, ${data.imapHost}, ${data.imapPort}, ${data.imapUsername},
            ${encryptSecret(data.imapPassword)}, ${data.imapTls ?? true},
            ${data.extraFolders ?? []}::text[],
            ${data.foldersOnly ?? false}, ${data.discardUnrouted ?? false})
    RETURNING *
  `
  return mapConnection(rows[0]!)
}

export async function updateConnection(id: string, data: {
  label?: string
  imapHost?: string
  imapPort?: number
  imapUsername?: string
  imapPassword?: string
  imapTls?: boolean
  extraFolders?: string[]
  foldersOnly?: boolean
  discardUnrouted?: boolean
}): Promise<Connection | null> {
  const sets: Prisma.Sql[] = []
  if (data.label !== undefined) sets.push(Prisma.sql`"label" = ${data.label}`)
  if (data.imapHost !== undefined) sets.push(Prisma.sql`"imap_host" = ${data.imapHost}`)
  if (data.imapPort !== undefined) sets.push(Prisma.sql`"imap_port" = ${data.imapPort}`)
  if (data.imapUsername !== undefined) sets.push(Prisma.sql`"imap_username" = ${data.imapUsername}`)
  if (data.imapTls !== undefined) sets.push(Prisma.sql`"imap_tls" = ${data.imapTls}`)
  if (data.extraFolders !== undefined) sets.push(Prisma.sql`"extra_folders" = ${data.extraFolders}::text[]`)
  if (data.foldersOnly !== undefined) sets.push(Prisma.sql`"folders_only" = ${data.foldersOnly}`)
  if (data.discardUnrouted !== undefined) sets.push(Prisma.sql`"discard_unrouted" = ${data.discardUnrouted}`)
  const secret = optionalSecret(data.imapPassword)
  if (secret !== undefined) sets.push(Prisma.sql`"imap_password_encrypted" = ${secret}`)
  if (sets.length === 0) return getConnection(id)

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    UPDATE "uin_connections"
       SET ${Prisma.join(sets, ', ')}, "updated_at" = now()
     WHERE "id" = ${id}
    RETURNING *
  `
  return rows[0] ? mapConnection(rows[0]) : null
}

export async function deleteConnection(id: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "uin_connections" WHERE "id" = ${id}`
}

/** Keeps whatever folder discovery just found, so the folder pickers on the
 *  settings screen have a menu to draw without opening somebody's mailbox on a
 *  page load. Never called on a failed connection: a server that would not
 *  answer has not told us its folders have gone, only that it is not talking,
 *  and throwing the last known list away over that would leave the pickers
 *  empty for no reason. */
export async function recordDiscoveredFolders(
  id: string,
  folders: DiscoveredFolder[]
): Promise<Date> {
  const checkedAt = new Date()
  await prisma.$executeRaw`
    UPDATE "uin_connections"
       SET "discovered_folders" = ${JSON.stringify(folders)}::jsonb,
           "folders_checked_at" = ${checkedAt},
           "updated_at" = now()
     WHERE "id" = ${id}
  `
  return checkedAt
}

export async function recordConnectionSync(
  id: string,
  status: SyncStatus,
  error: string | null
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "uin_connections"
       SET "last_sync_at" = now(),
           "last_sync_status" = ${status},
           "last_sync_error" = ${error ? error.slice(0, 2000) : null},
           "updated_at" = now()
     WHERE "id" = ${id}
  `
}

// ---------------------------------------------------------------------------
// Inboxes
// ---------------------------------------------------------------------------

function mapInbox(r: Record<string, unknown>): Inbox {
  return {
    id: r.id as string,
    name: r.name as string,
    address: r.address as string,
    connectionId: (r.connection_id as string | null) ?? null,
    imapFolder: (r.imap_folder as string) ?? 'INBOX',
    sentFolder: (r.sent_folder as string | null) ?? null,
    isCatchAll: !!r.is_catch_all,
    sendTransport: (r.send_transport as SendTransport) ?? 'brevo',
    hasBrevoKey: !!r.brevo_api_key_encrypted,
    smtpHost: (r.smtp_host as string | null) ?? null,
    smtpPort: r.smtp_port === null || r.smtp_port === undefined ? null : Number(r.smtp_port),
    smtpUsername: (r.smtp_username as string | null) ?? null,
    hasSmtpPassword: !!r.smtp_password_encrypted,
    fromName: (r.from_name as string | null) ?? null,
    signatureKind: isSignatureKind(r.signature_kind) ? r.signature_kind : 'markdown',
    signature: (r.signature as string | null) ?? null,
    signatureHtml: (r.signature_html as string | null) ?? null,
    signaturePuck: r.signature_puck ?? null,
    appendToSent: !!r.append_to_sent,
    colour: (r.colour as string | null) ?? null,
    sortOrder: Number(r.sort_order ?? 0),
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  }
}

/** Just the ids, for the access helpers - they take the full list and hand back
 *  the slice this person may read, or send from. Nothing needs the rows. */
export async function allInboxIds(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`SELECT "id" FROM "uin_inboxes"`
  return rows.map((r) => r.id)
}

export async function listInboxes(): Promise<Inbox[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_inboxes" ORDER BY "sort_order" ASC, "name" ASC
  `
  return rows.map(mapInbox)
}

export async function getInbox(id: string): Promise<Inbox | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_inboxes" WHERE "id" = ${id}
  `
  return rows[0] ? mapInbox(rows[0]) : null
}

export type InboxInput = {
  name: string
  address: string
  connectionId?: string | null
  imapFolder?: string
  sentFolder?: string | null
  isCatchAll?: boolean
  sendTransport?: SendTransport
  brevoApiKey?: string | null
  smtpHost?: string | null
  smtpPort?: number | null
  smtpUsername?: string | null
  smtpPassword?: string | null
  fromName?: string | null
  signatureKind?: SignatureKind
  signature?: string | null
  signatureHtml?: string | null
  signaturePuck?: unknown
  appendToSent?: boolean
  colour?: string | null
  sortOrder?: number
}

export async function createInbox(data: InboxInput): Promise<Inbox> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    INSERT INTO "uin_inboxes"
      ("name", "address", "connection_id", "imap_folder", "sent_folder", "is_catch_all",
       "send_transport", "brevo_api_key_encrypted", "smtp_host", "smtp_port", "smtp_username",
       "smtp_password_encrypted", "from_name", "signature_kind", "signature", "signature_html",
       "signature_puck", "append_to_sent", "colour", "sort_order")
    VALUES (${data.name}, ${normaliseAddress(data.address)}, ${data.connectionId ?? null},
            ${data.imapFolder ?? 'INBOX'}, ${data.sentFolder ?? null}, ${data.isCatchAll ?? false},
            ${data.sendTransport ?? 'brevo'}, ${optionalSecret(data.brevoApiKey) ?? null},
            ${data.smtpHost ?? null}, ${data.smtpPort ?? null}, ${data.smtpUsername ?? null},
            ${optionalSecret(data.smtpPassword) ?? null}, ${data.fromName ?? null},
            ${data.signatureKind ?? 'markdown'}, ${data.signature ?? null}, ${data.signatureHtml ?? null},
            ${jsonOrNull(data.signaturePuck)}, ${data.appendToSent ?? false}, ${data.colour ?? null},
            ${data.sortOrder ?? 0})
    RETURNING *
  `
  return mapInbox(rows[0]!)
}

export async function updateInbox(id: string, data: Partial<InboxInput>): Promise<Inbox | null> {
  const sets: Prisma.Sql[] = []
  if (data.name !== undefined) sets.push(Prisma.sql`"name" = ${data.name}`)
  if (data.address !== undefined) sets.push(Prisma.sql`"address" = ${normaliseAddress(data.address)}`)
  if (data.connectionId !== undefined) sets.push(Prisma.sql`"connection_id" = ${data.connectionId}`)
  if (data.imapFolder !== undefined) sets.push(Prisma.sql`"imap_folder" = ${data.imapFolder}`)
  if (data.sentFolder !== undefined) sets.push(Prisma.sql`"sent_folder" = ${data.sentFolder}`)
  if (data.isCatchAll !== undefined) sets.push(Prisma.sql`"is_catch_all" = ${data.isCatchAll}`)
  if (data.sendTransport !== undefined) sets.push(Prisma.sql`"send_transport" = ${data.sendTransport}`)
  if (data.smtpHost !== undefined) sets.push(Prisma.sql`"smtp_host" = ${data.smtpHost}`)
  if (data.smtpPort !== undefined) sets.push(Prisma.sql`"smtp_port" = ${data.smtpPort}`)
  if (data.smtpUsername !== undefined) sets.push(Prisma.sql`"smtp_username" = ${data.smtpUsername}`)
  if (data.fromName !== undefined) sets.push(Prisma.sql`"from_name" = ${data.fromName}`)
  if (data.signatureKind !== undefined) sets.push(Prisma.sql`"signature_kind" = ${data.signatureKind}`)
  if (data.signature !== undefined) sets.push(Prisma.sql`"signature" = ${data.signature}`)
  if (data.signatureHtml !== undefined) sets.push(Prisma.sql`"signature_html" = ${data.signatureHtml}`)
  if (data.signaturePuck !== undefined) sets.push(Prisma.sql`"signature_puck" = ${jsonOrNull(data.signaturePuck)}`)
  if (data.appendToSent !== undefined) sets.push(Prisma.sql`"append_to_sent" = ${data.appendToSent}`)
  if (data.colour !== undefined) sets.push(Prisma.sql`"colour" = ${data.colour}`)
  if (data.sortOrder !== undefined) sets.push(Prisma.sql`"sort_order" = ${data.sortOrder}`)
  const brevoKey = optionalSecret(data.brevoApiKey)
  if (brevoKey !== undefined) sets.push(Prisma.sql`"brevo_api_key_encrypted" = ${brevoKey}`)
  const smtpPassword = optionalSecret(data.smtpPassword)
  if (smtpPassword !== undefined) sets.push(Prisma.sql`"smtp_password_encrypted" = ${smtpPassword}`)
  if (sets.length === 0) return getInbox(id)

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    UPDATE "uin_inboxes"
       SET ${Prisma.join(sets, ', ')}, "updated_at" = now()
     WHERE "id" = ${id}
    RETURNING *
  `
  return rows[0] ? mapInbox(rows[0]) : null
}

export async function deleteInbox(id: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "uin_inboxes" WHERE "id" = ${id}`
}

/**
 * Put the inboxes in the order somebody dragged them into.
 *
 * The whole list arrives at once and is written as positions 0..n-1, rather
 * than one inbox being nudged up by a place: two people rearranging them at
 * the same time then end up with one of the two orders, not a shuffle of both.
 * One statement, so the order is never briefly half-sorted.
 */
export async function reorderInboxes(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  // The positions are cast rather than left bare: every arm of the CASE is a
  // parameter, and Postgres will not guess a type it has never been told.
  const cases = ids.map((id, index) => Prisma.sql`WHEN ${id} THEN ${index}::int`)
  await prisma.$executeRaw`
    UPDATE "uin_inboxes"
       SET "sort_order" = CASE "id" ${Prisma.join(cases, ' ')} END,
           "updated_at" = now()
     WHERE "id" IN (${Prisma.join(ids)})
  `
}

/** Every other inbox using this address, so a duplicate is refused with a
 *  sentence rather than a unique-constraint error. */
/**
 * An inbox's own sending credentials, still encrypted.
 *
 * Server only, and returned encrypted so the decryption happens at the single
 * point of use rather than anywhere a value could be logged or serialised into
 * a response by accident. Everything else about an inbox comes back with these
 * as plain booleans (`hasBrevoKey`, `hasSmtpPassword`).
 */
export async function getInboxSecrets(id: string): Promise<{
  brevoApiKey: string | null
  smtpPassword: string | null
}> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "brevo_api_key_encrypted", "smtp_password_encrypted"
      FROM "uin_inboxes" WHERE "id" = ${id}
  `
  const r = rows[0]
  return {
    brevoApiKey: (r?.brevo_api_key_encrypted as string | null) ?? null,
    smtpPassword: (r?.smtp_password_encrypted as string | null) ?? null,
  }
}

export async function addressTakenBy(address: string, exceptId?: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "uin_inboxes"
     WHERE "address" = ${normaliseAddress(address)}
       AND ("id" <> ${exceptId ?? ''})
     LIMIT 1
  `
  return rows[0]?.id ?? null
}

// ---------------------------------------------------------------------------
// Per-inbox access
// ---------------------------------------------------------------------------

export async function listInboxAccess(inboxId: string): Promise<InboxAccess[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "inbox_id", "user_id", "can_reply" FROM "uin_inbox_access" WHERE "inbox_id" = ${inboxId}
  `
  return rows.map((r) => ({
    inboxId: r.inbox_id as string,
    userId: r.user_id as string,
    canReply: !!r.can_reply,
  }))
}

/** Every access row on the site, for resolving one user's view of the addresses in
 *  a single query rather than one per inbox. */
export async function listAllInboxAccess(): Promise<InboxAccess[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "inbox_id", "user_id", "can_reply" FROM "uin_inbox_access"
  `
  return rows.map((r) => ({
    inboxId: r.inbox_id as string,
    userId: r.user_id as string,
    canReply: !!r.can_reply,
  }))
}

// ---------------------------------------------------------------------------
// Somebody's own inbox
//
// Kept apart from the guest list on purpose: an inbox with no access rows is
// open to everybody who may read the hub at all, so recording a preference on
// that table would restrict the address as a side effect of expressing it.
// ---------------------------------------------------------------------------

/** Every "this address is theirs" row on the site, for drawing the settings
 *  screen in one query rather than one per person. */
export async function listUserDefaultInboxes(): Promise<UserDefaultInbox[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "user_id", "inbox_id" FROM "uin_user_default_inbox"
  `
  return rows.map((r) => ({ userId: r.user_id as string, inboxId: r.inbox_id as string }))
}

/** The address one person calls their own, or null when they have not been
 *  given one. Says nothing about whether they may still read it - the caller
 *  checks that, because the answer is different for the tabs and for a
 *  signature. */
export async function defaultInboxIdFor(userId: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ inbox_id: string }[]>`
    SELECT "inbox_id" FROM "uin_user_default_inbox" WHERE "user_id" = ${userId} LIMIT 1
  `
  return rows[0]?.inbox_id ?? null
}

/**
 * Who this inbox is for, saved in one go: the guest list, and the people whose
 * own address it is.
 *
 * An empty guest list is meaningful: it hands the address back to everybody who
 * can view the hub at all, which is the difference between no rows and a row
 * per person.
 *
 * Both halves in one transaction because they are one screenful and one Save.
 * Half of it landing would leave somebody named as an owner of an address they
 * had just been taken off, and nothing on the screen would say which half went.
 *
 * Naming somebody here moves their own inbox rather than adding a second one -
 * the primary key on the person is what makes that an update - and taking them
 * off leaves them with none at all, which is what everybody starts with.
 */
export async function setInboxAudience(
  inboxId: string,
  entries: Array<{ userId: string; canReply: boolean }>,
  defaultForUserIds: string[],
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`DELETE FROM "uin_inbox_access" WHERE "inbox_id" = ${inboxId}`
    for (const entry of entries) {
      await tx.$executeRaw`
        INSERT INTO "uin_inbox_access" ("inbox_id", "user_id", "can_reply")
        VALUES (${inboxId}, ${entry.userId}, ${entry.canReply})
        ON CONFLICT ("inbox_id", "user_id") DO UPDATE SET "can_reply" = EXCLUDED."can_reply"
      `
    }

    // Anybody who had this address as their own and is no longer on the list
    // goes back to having none. Scoped to THIS inbox, so a save here never
    // disturbs whoever calls another address their own.
    if (defaultForUserIds.length === 0) {
      await tx.$executeRaw`DELETE FROM "uin_user_default_inbox" WHERE "inbox_id" = ${inboxId}`
    } else {
      await tx.$executeRaw`
        DELETE FROM "uin_user_default_inbox"
         WHERE "inbox_id" = ${inboxId}
           AND "user_id" NOT IN (${Prisma.join(defaultForUserIds)})
      `
    }
    for (const userId of defaultForUserIds) {
      await tx.$executeRaw`
        INSERT INTO "uin_user_default_inbox" ("user_id", "inbox_id")
        VALUES (${userId}, ${inboxId})
        ON CONFLICT ("user_id")
        DO UPDATE SET "inbox_id" = EXCLUDED."inbox_id", "updated_at" = now()
      `
    }
  })
}

// ---------------------------------------------------------------------------
// Module settings (singleton row)
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS: UnifiedInboxSettings = {
  backfillMonths: 12,
  retentionMonths: null,
  retentionKeepLinked: true,
  retentionLastRunAt: null,
  attachmentFetch: 'lazy',
  autoLink: true,
  newestFirst: false,
  defaultInboxId: null,
  ownDomains: null,
  personalDomains: [],
  orderNumberPattern: null,
  poNumberPattern: null,
  quoteNumberPattern: null,
  trackOpens: false,
  requestReadReceipts: false,
}

export async function getSettings(): Promise<UnifiedInboxSettings> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_settings" WHERE "id" = 'singleton'
  `
  const r = rows[0]
  // The migration seeds the row, but a restored backup taken before it existed
  // would not have one, and an empty settings screen is a worse answer than the
  // defaults it would have shown anyway.
  if (!r) return DEFAULT_SETTINGS
  return {
    backfillMonths: Number(r.backfill_months ?? 12),
    retentionMonths: r.retention_months === null || r.retention_months === undefined
      ? null
      : Number(r.retention_months),
    // Defaults matter here: a site restored from a backup taken before this
    // column existed reads undefined, and the cautious answer is the one that
    // keeps mail rather than the one that removes it.
    retentionKeepLinked: r.retention_keep_linked === undefined ? true : !!r.retention_keep_linked,
    retentionLastRunAt: (r.retention_last_run_at as Date | null) ?? null,
    attachmentFetch: (r.attachment_fetch as AttachmentFetchMode) ?? 'lazy',
    autoLink: r.auto_link === undefined ? true : !!r.auto_link,
    // Off for a row written before the column existed, which is the order that
    // install has been reading in all along.
    newestFirst: !!r.newest_first,
    defaultInboxId: (r.default_inbox_id as string | null) ?? null,
    // NULL and an empty array mean different things here and both are real
    // answers: nothing set at all, versus somebody who has cleared the box.
    ownDomains: (r.own_domains as string[] | null) ?? null,
    personalDomains: (r.personal_domains as string[] | null) ?? [],
    orderNumberPattern: (r.order_number_pattern as string | null) ?? null,
    poNumberPattern: (r.po_number_pattern as string | null) ?? null,
    quoteNumberPattern: (r.quote_number_pattern as string | null) ?? null,
    // Both default to off for a row written before these columns existed, which
    // is the same answer a fresh install gets. Nobody is opted into being
    // tracked by a restore.
    trackOpens: !!r.track_opens,
    requestReadReceipts: !!r.request_read_receipts,
  }
}

export async function updateSettings(data: Partial<UnifiedInboxSettings>): Promise<UnifiedInboxSettings> {
  const sets: Prisma.Sql[] = []
  if (data.backfillMonths !== undefined) sets.push(Prisma.sql`"backfill_months" = ${data.backfillMonths}`)
  if (data.retentionMonths !== undefined) sets.push(Prisma.sql`"retention_months" = ${data.retentionMonths}`)
  if (data.retentionKeepLinked !== undefined) sets.push(Prisma.sql`"retention_keep_linked" = ${data.retentionKeepLinked}`)
  // retentionLastRunAt is deliberately absent: the sweep stamps it through
  // markRetentionRun, and a settings form that could write it would be able to
  // tell the screen a pass happened when none did.
  if (data.attachmentFetch !== undefined) sets.push(Prisma.sql`"attachment_fetch" = ${data.attachmentFetch}`)
  if (data.autoLink !== undefined) sets.push(Prisma.sql`"auto_link" = ${data.autoLink}`)
  if (data.newestFirst !== undefined) sets.push(Prisma.sql`"newest_first" = ${data.newestFirst}`)
  if (data.defaultInboxId !== undefined) sets.push(Prisma.sql`"default_inbox_id" = ${data.defaultInboxId}`)
  if (data.ownDomains !== undefined) sets.push(Prisma.sql`"own_domains" = ${data.ownDomains}::text[]`)
  if (data.personalDomains !== undefined) sets.push(Prisma.sql`"personal_domains" = ${data.personalDomains}::text[]`)
  if (data.orderNumberPattern !== undefined) sets.push(Prisma.sql`"order_number_pattern" = ${data.orderNumberPattern}`)
  if (data.poNumberPattern !== undefined) sets.push(Prisma.sql`"po_number_pattern" = ${data.poNumberPattern}`)
  if (data.quoteNumberPattern !== undefined) sets.push(Prisma.sql`"quote_number_pattern" = ${data.quoteNumberPattern}`)
  if (data.trackOpens !== undefined) sets.push(Prisma.sql`"track_opens" = ${data.trackOpens}`)
  if (data.requestReadReceipts !== undefined) sets.push(Prisma.sql`"request_read_receipts" = ${data.requestReadReceipts}`)
  if (sets.length === 0) return getSettings()

  await prisma.$executeRaw`
    INSERT INTO "uin_settings" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING
  `
  await prisma.$executeRaw`
    UPDATE "uin_settings"
       SET ${Prisma.join(sets, ', ')}, "updated_at" = now()
     WHERE "id" = 'singleton'
  `
  return getSettings()
}

// ---------------------------------------------------------------------------
// Ingest (S3): sync cursors, the location ledger, threads, messages and
// attachment rows. Same rule as everything above - the raw column names live
// here and nowhere else.
//
// BIGINT columns come back from Prisma raw queries as JavaScript BigInt, not
// number, and are converted on the way out. They are UIDs and counters, not
// money, so a Number is the right shape for the rest of the module; the column
// is BIGINT only because an IMAP UIDVALIDITY is a 32-bit UNSIGNED value and
// does not fit in a Postgres INTEGER.
// ---------------------------------------------------------------------------

function bigintToNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  return typeof value === 'bigint' ? Number(value) : Number(value as number)
}

export type SyncStateRow = {
  connectionId: string
  folder: string
  uidvalidity: number | null
  lastSeenUid: number
  backfillCursorUid: number | null
  backfillComplete: boolean
  lastRunAt: Date | null
  lastError: string | null
  totalEstimate: number | null
  collected: number
}

function mapSyncState(r: Record<string, unknown>): SyncStateRow {
  return {
    connectionId: r.connection_id as string,
    folder: r.folder as string,
    uidvalidity: bigintToNumber(r.uidvalidity),
    lastSeenUid: bigintToNumber(r.last_seen_uid) ?? 0,
    backfillCursorUid: bigintToNumber(r.backfill_cursor_uid),
    backfillComplete: !!r.backfill_complete,
    lastRunAt: (r.last_run_at as Date | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
    totalEstimate: bigintToNumber(r.total_estimate),
    collected: bigintToNumber(r.collected) ?? 0,
  }
}

export async function getSyncState(connectionId: string, folder: string): Promise<SyncStateRow | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_sync_state" WHERE "connection_id" = ${connectionId} AND "folder" = ${folder}
  `
  return rows[0] ? mapSyncState(rows[0]) : null
}

export async function listSyncState(connectionId?: string): Promise<SyncStateRow[]> {
  const rows = connectionId
    ? await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT * FROM "uin_sync_state" WHERE "connection_id" = ${connectionId} ORDER BY "folder" ASC
      `
    : await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT * FROM "uin_sync_state" ORDER BY "connection_id" ASC, "folder" ASC
      `
  return rows.map(mapSyncState)
}

/** Writes a folder's cursors. Called after every committed batch, never once at
 *  the end - an interrupted tick has to leave the next one somewhere sensible
 *  to carry on from. */
export async function saveSyncState(
  connectionId: string,
  folder: string,
  patch: Partial<Omit<SyncStateRow, 'connectionId' | 'folder'>>
): Promise<void> {
  const sets: Prisma.Sql[] = [Prisma.sql`"last_run_at" = now()`]
  if (patch.uidvalidity !== undefined) sets.push(Prisma.sql`"uidvalidity" = ${patch.uidvalidity}::bigint`)
  if (patch.lastSeenUid !== undefined) sets.push(Prisma.sql`"last_seen_uid" = ${patch.lastSeenUid}::bigint`)
  if (patch.backfillCursorUid !== undefined) sets.push(Prisma.sql`"backfill_cursor_uid" = ${patch.backfillCursorUid}::bigint`)
  if (patch.backfillComplete !== undefined) sets.push(Prisma.sql`"backfill_complete" = ${patch.backfillComplete}`)
  if (patch.lastError !== undefined) sets.push(Prisma.sql`"last_error" = ${patch.lastError ? patch.lastError.slice(0, 2000) : null}`)
  if (patch.totalEstimate !== undefined) sets.push(Prisma.sql`"total_estimate" = ${patch.totalEstimate}::bigint`)
  if (patch.collected !== undefined) sets.push(Prisma.sql`"collected" = ${patch.collected}::bigint`)

  await prisma.$executeRaw`
    INSERT INTO "uin_sync_state" ("connection_id", "folder") VALUES (${connectionId}, ${folder})
    ON CONFLICT ("connection_id", "folder") DO NOTHING
  `
  await prisma.$executeRaw`
    UPDATE "uin_sync_state" SET ${Prisma.join(sets, ', ')}
     WHERE "connection_id" = ${connectionId} AND "folder" = ${folder}
  `
}

/**
 * The per-account lock (E6). An hourly tick, a manual check and a copy-to-Sent
 * can all want one iCloud account at once, and iCloud caps how many connections
 * it will hold open. Whoever gets the row runs; everybody else is told it is
 * already running and comes back later.
 */
export async function acquireConnectionLock(connectionId: string, holdMs: number): Promise<boolean> {
  const seconds = Math.max(1, Math.ceil(holdMs / 1000))
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "uin_connections"
       SET "locked_until" = now() + make_interval(secs => ${seconds}::double precision)
     WHERE "id" = ${connectionId}
       AND ("locked_until" IS NULL OR "locked_until" < now())
    RETURNING "id"
  `
  return rows.length > 0
}

export async function releaseConnectionLock(connectionId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "uin_connections" SET "locked_until" = NULL WHERE "id" = ${connectionId}
  `
}

/** Consecutive authentication failures, so a revoked app password raises a
 *  notification rather than quietly stopping the site's mail (E10). */
export async function recordAuthFailure(connectionId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ auth_failures: number }[]>`
    UPDATE "uin_connections" SET "auth_failures" = "auth_failures" + 1 WHERE "id" = ${connectionId}
    RETURNING "auth_failures"
  `
  return Number(rows[0]?.auth_failures ?? 0)
}

export async function clearAuthFailures(connectionId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "uin_connections" SET "auth_failures" = 0 WHERE "id" = ${connectionId} AND "auth_failures" <> 0
  `
}

export async function getAuthFailures(connectionId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ auth_failures: number }[]>`
    SELECT "auth_failures" FROM "uin_connections" WHERE "id" = ${connectionId}
  `
  return Number(rows[0]?.auth_failures ?? 0)
}

// ---------------------------------------------------------------------------
// The location ledger. This records that a (folder, uid) has been read. It does
// NOT decide whether we already hold the message - that is message_id_header's
// job, because the same message lives at several locations.
// ---------------------------------------------------------------------------

export async function getProcessedUids(
  connectionId: string,
  folder: string,
  uids: number[]
): Promise<Set<number>> {
  if (uids.length === 0) return new Set()
  const rows = await prisma.$queryRaw<{ uid: bigint | number }[]>`
    SELECT "uid" FROM "uin_processed_messages"
     WHERE "connection_id" = ${connectionId}
       AND "folder" = ${folder}
       AND "uid" = ANY(${uids.map((u) => String(u))}::bigint[])
  `
  return new Set(rows.map((r) => Number(r.uid)))
}

export async function markLocationProcessed(entry: {
  connectionId: string
  folder: string
  uid: number
  messageIdHeader: string | null
  threadId: string | null
}): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "uin_processed_messages"
      ("connection_id", "folder", "uid", "message_id_header", "thread_id")
    VALUES (${entry.connectionId}, ${entry.folder}, ${entry.uid}::bigint,
            ${entry.messageIdHeader}, ${entry.threadId})
    ON CONFLICT ("connection_id", "folder", "uid") DO UPDATE
       SET "message_id_header" = EXCLUDED."message_id_header",
           "thread_id" = COALESCE(EXCLUDED."thread_id", "uin_processed_messages"."thread_id")
  `
}

// ---------------------------------------------------------------------------
// Messages and threads
// ---------------------------------------------------------------------------

export type StoredMessageRef = {
  id: string
  threadId: string
  messageIdHeader: string | null
  imapFolder: string | null
  imapUid: number | null
}

/** Do we already hold this message on this account, wherever it was found? */
export async function findMessageByIdentity(
  connectionId: string,
  messageIdHeader: string
): Promise<StoredMessageRef | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "id", "thread_id", "message_id_header", "imap_folder", "imap_uid"
      FROM "uin_messages"
     WHERE "connection_id" = ${connectionId} AND "message_id_header" = ${messageIdHeader}
     LIMIT 1
  `
  const r = rows[0]
  if (!r) return null
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    messageIdHeader: (r.message_id_header as string | null) ?? null,
    imapFolder: (r.imap_folder as string | null) ?? null,
    imapUid: bigintToNumber(r.imap_uid),
  }
}

/**
 * The copy of a message we sent ourselves, matched on the Message-ID we
 * generated before sending (E11). Outbound mail has no connection until the
 * account's Sent folder hands it back, so it is looked up by header alone -
 * and finding one means the sync has just met its own sent mail, not a new
 * message.
 */
export async function findOutboundByMessageId(messageIdHeader: string): Promise<StoredMessageRef | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "id", "thread_id", "message_id_header", "imap_folder", "imap_uid"
      FROM "uin_messages"
     WHERE "message_id_header" = ${messageIdHeader} AND "direction" = 'out'
     LIMIT 1
  `
  const r = rows[0]
  if (!r) return null
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    messageIdHeader: (r.message_id_header as string | null) ?? null,
    imapFolder: (r.imap_folder as string | null) ?? null,
    imapUid: bigintToNumber(r.imap_uid),
  }
}

/** Attach a location to a message we already hold - the outbound reply that has
 *  just come back from the Sent folder, so its attachments can be fetched later
 *  without a second search. */
export async function attachLocation(
  messageId: string,
  location: { connectionId: string; folder: string; uid: number }
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "uin_messages"
       SET "connection_id" = COALESCE("connection_id", ${location.connectionId}),
           "imap_folder" = COALESCE("imap_folder", ${location.folder}),
           "imap_uid" = COALESCE("imap_uid", ${location.uid}::bigint)
     WHERE "id" = ${messageId}
  `
}

/**
 * Thread ids for referenced Message-IDs, for header threading.
 *
 * Matches the provider's own id as well as ours, and that second half is not
 * belt and braces. Brevo may replace the Message-ID we set with one of its own
 * on the way out; if it does, the customer's mail client quotes BREVO's id back
 * at us in In-Reply-To, and matching only on the id we generated would start a
 * fresh conversation for every single reply. The provider's id is stored on the
 * outbound row the moment a send settles, so both handles lead to the same
 * thread whichever one comes back.
 */
export async function threadsForMessageIds(
  messageIds: string[]
): Promise<Map<string, string>> {
  if (messageIds.length === 0) return new Map()
  const rows = await prisma.$queryRaw<{ message_id_header: string; thread_id: string }[]>`
    SELECT "message_id_header", "thread_id" FROM "uin_messages"
     WHERE "message_id_header" = ANY(${messageIds}::text[])
    UNION ALL
    SELECT "provider_message_id" AS "message_id_header", "thread_id" FROM "uin_messages"
     WHERE "provider_message_id" = ANY(${messageIds}::text[])
  `
  const map = new Map<string, string>()
  for (const row of rows) if (!map.has(row.message_id_header)) map.set(row.message_id_header, row.thread_id)
  return map
}

export type ThreadCandidateRow = {
  id: string
  inboxId: string | null
  subjectNormalised: string | null
  lastMessageAt: Date | null
  participants: string[]
}

/** Threads that could be the same conversation as a message the headers cannot
 *  place: same normalised subject, recent enough to still be one. */
export async function candidateThreads(
  subjectNormalised: string,
  since: Date
): Promise<ThreadCandidateRow[]> {
  if (!subjectNormalised) return []
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT t."id", t."inbox_id", t."subject_normalised", t."last_message_at",
           COALESCE(
             ARRAY(
               SELECT DISTINCT m."from_address" FROM "uin_messages" m
                WHERE m."thread_id" = t."id" AND m."from_address" IS NOT NULL
                LIMIT 50
             ),
             ARRAY[]::text[]
           ) AS participants
      FROM "uin_threads" t
     WHERE t."subject_normalised" = ${subjectNormalised}
       AND t."channel" = 'email'
       AND (t."last_message_at" IS NULL OR t."last_message_at" >= ${since})
     ORDER BY t."last_message_at" DESC NULLS LAST
     LIMIT 25
  `
  return rows.map((r) => ({
    id: r.id as string,
    inboxId: (r.inbox_id as string | null) ?? null,
    subjectNormalised: (r.subject_normalised as string | null) ?? null,
    lastMessageAt: (r.last_message_at as Date | null) ?? null,
    participants: (r.participants as string[] | null) ?? [],
  }))
}

export async function createThread(data: {
  inboxId: string | null
  subject: string | null
  subjectNormalised: string
  preview: string | null
  lastMessageAt: Date
  lastDirection: 'in' | 'out' | 'note'
  unread: boolean
}): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "uin_threads"
      ("inbox_id", "channel", "subject", "subject_normalised", "preview",
       "last_message_at", "last_direction", "unread", "message_count")
    VALUES (${data.inboxId}, 'email', ${data.subject}, ${data.subjectNormalised}, ${data.preview},
            ${data.lastMessageAt}, ${data.lastDirection}, ${data.unread}, 0)
    RETURNING "id"
  `
  return rows[0]!.id
}

export type InsertMessageInput = {
  threadId: string
  connectionId: string
  direction: 'in' | 'out' | 'note'
  messageIdHeader: string
  inReplyTo: string | null
  references: string[]
  fromName: string | null
  fromAddress: string | null
  /** The sender's Reply-To, when they set one. It beats From when we answer
   *  (E13), so it has to survive ingest rather than be re-derived later. */
  replyTo: string | null
  toAddresses: string[]
  ccAddresses: string[]
  subject: string | null
  bodyText: string | null
  bodyHtml: string | null
  snippet: string | null
  sentAt: Date
  hasAttachments: boolean
  sizeBytes: number | null
  imapFolder: string
  imapUid: number
  threadMatch: string
  routedOn: string
  autoKind: string | null
}

/**
 * Files a message. The unique index on (connection_id, message_id_header) is the
 * real guard: two ticks racing, or the same mail found in a second folder, both
 * land on ON CONFLICT DO NOTHING and return null rather than a duplicate.
 */
export async function insertMessage(data: InsertMessageInput): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "uin_messages"
      ("thread_id", "connection_id", "direction", "channel", "message_id_header", "in_reply_to",
       "references_header", "from_name", "from_address", "reply_to", "to_addresses", "cc_addresses", "subject",
       "body_text", "body_html", "snippet", "sent_at", "has_attachments", "size_bytes", "source",
       "imap_folder", "imap_uid", "thread_match", "routed_on", "auto_kind")
    VALUES (${data.threadId}, ${data.connectionId}, ${data.direction}, 'email', ${data.messageIdHeader},
            ${data.inReplyTo}, ${data.references}::text[], ${data.fromName}, ${data.fromAddress},
            ${data.replyTo}, ${data.toAddresses}::text[], ${data.ccAddresses}::text[], ${data.subject}, ${data.bodyText},
            ${data.bodyHtml}, ${data.snippet}, ${data.sentAt}, ${data.hasAttachments}, ${data.sizeBytes},
            'imap', ${data.imapFolder}, ${data.imapUid}::bigint, ${data.threadMatch}, ${data.routedOn},
            ${data.autoKind})
    ON CONFLICT ("connection_id", "message_id_header")
      WHERE "connection_id" IS NOT NULL AND "message_id_header" IS NOT NULL
      DO NOTHING
    RETURNING "id"
  `
  return rows[0]?.id ?? null
}

/** Rolls the thread forward after a message lands on it. An automated reply
 *  (an out-of-office, a bounce) updates the timestamps but never marks the
 *  conversation unread - the customer has not said anything. */
export async function touchThread(threadId: string, data: {
  sentAt: Date
  direction: 'in' | 'out' | 'note'
  preview: string | null
  subject: string | null
  subjectNormalised: string
  markUnread: boolean
  inboxId: string | null
}): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "uin_threads"
       SET "last_message_at" = GREATEST(COALESCE("last_message_at", ${data.sentAt}), ${data.sentAt}),
           "last_direction" = CASE WHEN "last_message_at" IS NULL OR "last_message_at" <= ${data.sentAt}
                                   THEN ${data.direction} ELSE "last_direction" END,
           "preview" = CASE WHEN "last_message_at" IS NULL OR "last_message_at" <= ${data.sentAt}
                            THEN ${data.preview} ELSE "preview" END,
           "subject" = COALESCE("subject", ${data.subject}),
           "subject_normalised" = COALESCE(NULLIF("subject_normalised", ''), ${data.subjectNormalised}),
           "inbox_id" = COALESCE("inbox_id", ${data.inboxId}),
           "unread" = CASE WHEN ${data.markUnread} THEN true ELSE "unread" END,
           "message_count" = (SELECT COUNT(*) FROM "uin_messages" WHERE "thread_id" = ${threadId}),
           "updated_at" = now()
     WHERE "id" = ${threadId}
  `
}

// ---------------------------------------------------------------------------
// Attachments. Metadata at sync time, bytes only when somebody opens one.
// ---------------------------------------------------------------------------

export async function insertAttachment(data: {
  messageId: string
  filename: string
  contentType: string | null
  sizeBytes: number | null
  imapPartId: string
}): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "uin_attachments" ("message_id", "filename", "content_type", "size_bytes", "imap_part_id")
    VALUES (${data.messageId}, ${data.filename}, ${data.contentType}, ${data.sizeBytes}, ${data.imapPartId})
    RETURNING "id"
  `
  return rows[0]!.id
}

export type AttachmentRow = {
  id: string
  messageId: string
  filename: string
  contentType: string | null
  sizeBytes: number | null
  mediaKey: string | null
  mediaProvider: string | null
  mediaUrl: string | null
  imapPartId: string | null
  fetchedAt: Date | null
  /** Where the message it belongs to was found, so the bytes can be fetched. */
  connectionId: string | null
  imapFolder: string | null
  imapUid: number | null
  threadId: string
  inboxId: string | null
  /** External URL for provider attachments (e.g. Twilio voicemail recordings). */
  externalUrl: string | null
}

function mapAttachment(r: Record<string, unknown>): AttachmentRow {
  return {
    id: r.id as string,
    messageId: r.message_id as string,
    filename: r.filename as string,
    contentType: (r.content_type as string | null) ?? null,
    sizeBytes: r.size_bytes === null || r.size_bytes === undefined ? null : Number(r.size_bytes),
    mediaKey: (r.media_key as string | null) ?? null,
    mediaProvider: (r.media_provider as string | null) ?? null,
    mediaUrl: (r.media_url as string | null) ?? null,
    imapPartId: (r.imap_part_id as string | null) ?? null,
    fetchedAt: (r.fetched_at as Date | null) ?? null,
    connectionId: (r.connection_id as string | null) ?? null,
    imapFolder: (r.imap_folder as string | null) ?? null,
    imapUid: r.imap_uid === null || r.imap_uid === undefined ? null : Number(r.imap_uid),
    threadId: r.thread_id as string,
    inboxId: (r.inbox_id as string | null) ?? null,
    externalUrl: (r.external_url as string | null) ?? null,
  }
}

/** Every column the mapper wants, in the one shape three callers share. */
const ATTACHMENT_SELECT = Prisma.sql`
    SELECT a.*, m."connection_id", m."imap_folder", m."imap_uid", m."thread_id", t."inbox_id"
      FROM "uin_attachments" a
      JOIN "uin_messages" m ON m."id" = a."message_id"
      JOIN "uin_threads" t ON t."id" = m."thread_id"`

export async function getAttachment(id: string): Promise<AttachmentRow | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    ${ATTACHMENT_SELECT}
     WHERE a."id" = ${id}
  `
  return rows[0] ? mapAttachment(rows[0]) : null
}

export async function listAttachmentsForMessage(messageId: string): Promise<AttachmentRow[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    ${ATTACHMENT_SELECT}
     WHERE a."message_id" = ${messageId}
     ORDER BY a."created_at" ASC
  `
  return rows.map(mapAttachment)
}

export async function recordAttachmentStored(id: string, stored: {
  key: string
  provider: string
  url: string
  sizeBytes: number
}): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "uin_attachments"
       SET "media_key" = ${stored.key},
           "media_provider" = ${stored.provider},
           "media_url" = ${stored.url},
           "size_bytes" = ${stored.sizeBytes},
           "fetched_at" = now()
     WHERE "id" = ${id}
  `
}

/** Every storage key and url this module is holding on to, for the media usage
 *  provider. These objects have no library row by design, and without something
 *  vouching for them the storage check would classify the lot as orphaned. */
export async function listAttachmentStorageRefs(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ ref: string | null }[]>`
    SELECT "media_key" AS ref FROM "uin_attachments" WHERE "media_key" IS NOT NULL
    UNION ALL
    SELECT "media_url" AS ref FROM "uin_attachments" WHERE "media_url" IS NOT NULL
    UNION ALL
    SELECT "media_key" AS ref FROM "uin_outbound_uploads"
    UNION ALL
    SELECT "media_url" AS ref FROM "uin_outbound_uploads"
  `
  return rows.map((r) => r.ref).filter((r): r is string => !!r)
}

// ---------------------------------------------------------------------------
// Files dropped onto a message that has not been sent yet
// ---------------------------------------------------------------------------

export type OutboundUpload = {
  id: string
  mediaKey: string
  mediaUrl: string
  mediaProvider: string
  filename: string
  contentType: string | null
  sizeBytes: number
}

/** One dropped file, now in storage, remembered so that neither core's storage
 *  repair nor this module's own housekeeping can lose track of it. */
export async function recordOutboundUpload(data: {
  authorUserId: string
  mediaKey: string
  mediaUrl: string
  mediaProvider: string
  filename: string
  contentType: string | null
  sizeBytes: number
}): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "uin_outbound_uploads"
      ("author_user_id", "media_key", "media_url", "media_provider",
       "filename", "content_type", "size_bytes")
    VALUES (${data.authorUserId}, ${data.mediaKey}, ${data.mediaUrl}, ${data.mediaProvider},
            ${data.filename}, ${data.contentType}, ${data.sizeBytes})
    RETURNING "id"
  `
  return rows[0]!.id
}

/**
 * Dropped files old enough to be given up on, and pointed at by nothing.
 *
 * "Pointed at by nothing" is the whole of the safety here, and it is asked of
 * both places a reference can live: an attachment row, written when the message
 * actually went, and a draft that is still waiting to be finished. A draft's
 * files are a JSON array of the same references the send route takes, so the
 * key is looked for inside it as text - which is exact, because a key carries a
 * uuid no other string in that column would contain.
 */
export async function abandonedOutboundUploads(
  olderThan: Date,
  limit: number,
): Promise<OutboundUpload[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT u."id", u."media_key", u."media_url", u."media_provider",
           u."filename", u."content_type", u."size_bytes"
      FROM "uin_outbound_uploads" u
     WHERE u."created_at" < ${olderThan}
       AND NOT EXISTS (
             SELECT 1 FROM "uin_attachments" a WHERE a."media_key" = u."media_key"
           )
       AND NOT EXISTS (
             SELECT 1 FROM "uin_drafts" d
              WHERE d."attachments"::text LIKE '%' || u."media_key" || '%'
           )
     ORDER BY u."created_at" ASC
     LIMIT ${limit}
  `
  return rows.map((row) => ({
    id: String(row.id),
    mediaKey: String(row.media_key),
    mediaUrl: String(row.media_url),
    mediaProvider: String(row.media_provider),
    filename: String(row.filename),
    contentType: row.content_type === null ? null : String(row.content_type),
    sizeBytes: Number(row.size_bytes ?? 0),
  }))
}

/** The rows, once their bytes have gone. Bytes first, rows second, exactly as
 *  retention does it: an interrupted sweep leaves an object nothing points at,
 *  which is recoverable, rather than a row pointing at bytes that have gone. */
export async function deleteOutboundUploads(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  return prisma.$executeRaw`
    DELETE FROM "uin_outbound_uploads" WHERE "id" = ANY(${ids}::text[])
  `
}

// ---------------------------------------------------------------------------
// What the settings screen shows about collection
// ---------------------------------------------------------------------------

export type CollectionStat = {
  connectionId: string
  folders: number
  collected: number
  estimated: number | null
  backfillComplete: boolean
  lastRunAt: Date | null
  lastError: string | null
}

export async function collectionStats(): Promise<CollectionStat[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "connection_id",
           COUNT(*)::int                                    AS folders,
           COALESCE(SUM("collected"), 0)                    AS collected,
           SUM("total_estimate")                            AS estimated,
           BOOL_AND("backfill_complete")                    AS backfill_complete,
           MAX("last_run_at")                               AS last_run_at,
           MAX("last_error")                                AS last_error
      FROM "uin_sync_state"
     GROUP BY "connection_id"
  `
  return rows.map((r) => ({
    connectionId: r.connection_id as string,
    folders: Number(r.folders ?? 0),
    collected: bigintToNumber(r.collected) ?? 0,
    estimated: bigintToNumber(r.estimated),
    backfillComplete: !!r.backfill_complete,
    lastRunAt: (r.last_run_at as Date | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
  }))
}

/** Mail that reached the account but matched no inbox and had no catch-all to
 *  fall into. Silence here is the owner never learning that a whole address is
 *  not being read. */
export async function unroutedCount(): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM "uin_messages" WHERE "routed_on" = 'none'
  `
  return Number(rows[0]?.count ?? 0)
}

// ---------------------------------------------------------------------------
// The send path (S4)
//
// The order of operations here is the whole safety story, so it is written down
// rather than left to be inferred:
//
//   1. The row is written FIRST, with delivery_status 'sending'. If the process
//      dies between here and the network call, the fact that we tried survives,
//      and a message stuck in 'sending' is findable. Writing the row after the
//      send would mean a crash loses an email that the customer has already
//      received, which is the one outcome nobody can recover from.
//   2. The row carries the idempotency key, on a unique index. A second request
//      with the same key inserts nothing and is handed the first row back, so a
//      double-clicked Send is one email (E14).
//   3. The row is settled afterwards - 'sent' with the provider's id, or
//      'failed' with a sentence explaining why in words a person can act on.
// ---------------------------------------------------------------------------

export type OutboundMessageInput = {
  threadId: string
  inboxId: string
  idempotencyKey: string
  messageIdHeader: string
  inReplyTo: string | null
  references: string[]
  fromName: string | null
  fromAddress: string
  toAddresses: string[]
  ccAddresses: string[]
  subject: string
  bodyText: string
  bodyHtml: string
  snippet: string
  hasAttachments: boolean
  sizeBytes: number | null
  authorUserId: string
}

export type OutboundMessageRow = {
  id: string
  threadId: string
  inboxId: string | null
  direction: 'in' | 'out' | 'note'
  messageIdHeader: string | null
  providerMessageId: string | null
  deliveryStatus: string | null
  deliveryError: string | null
  appendStatus: string | null
  appendError: string | null
  idempotencyKey: string | null
  fromName: string | null
  fromAddress: string | null
  toAddresses: string[]
  ccAddresses: string[]
  subject: string | null
  bodyText: string | null
  bodyHtml: string | null
  sentAt: Date
  authorUserId: string | null
  hasAttachments: boolean
}

function mapOutbound(r: Record<string, unknown>): OutboundMessageRow {
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    inboxId: (r.inbox_id as string | null) ?? null,
    direction: r.direction as 'in' | 'out' | 'note',
    messageIdHeader: (r.message_id_header as string | null) ?? null,
    providerMessageId: (r.provider_message_id as string | null) ?? null,
    deliveryStatus: (r.delivery_status as string | null) ?? null,
    deliveryError: (r.delivery_error as string | null) ?? null,
    appendStatus: (r.append_status as string | null) ?? null,
    appendError: (r.append_error as string | null) ?? null,
    idempotencyKey: (r.idempotency_key as string | null) ?? null,
    fromName: (r.from_name as string | null) ?? null,
    fromAddress: (r.from_address as string | null) ?? null,
    toAddresses: (r.to_addresses as string[] | null) ?? [],
    ccAddresses: (r.cc_addresses as string[] | null) ?? [],
    subject: (r.subject as string | null) ?? null,
    bodyText: (r.body_text as string | null) ?? null,
    bodyHtml: (r.body_html as string | null) ?? null,
    sentAt: r.sent_at as Date,
    authorUserId: (r.author_user_id as string | null) ?? null,
    hasAttachments: !!r.has_attachments,
  }
}

/**
 * Writes the outbound row before anything is sent.
 *
 * `created` false means this exact send has been asked for already - the caller
 * must NOT send again, and should answer with the row it gets back.
 */
export async function insertOutboundMessage(
  data: OutboundMessageInput
): Promise<{ row: OutboundMessageRow; created: boolean }> {
  const inserted = await prisma.$queryRaw<Record<string, unknown>[]>`
    INSERT INTO "uin_messages"
      ("thread_id", "inbox_id", "direction", "channel", "message_id_header", "in_reply_to",
       "references_header", "from_name", "from_address", "to_addresses", "cc_addresses",
       "subject", "body_text", "body_html", "snippet", "sent_at", "has_attachments",
       "size_bytes", "source", "delivery_status", "author_user_id", "idempotency_key",
       "thread_match", "routed_on")
    VALUES (${data.threadId}, ${data.inboxId}, 'out', 'email', ${data.messageIdHeader},
            ${data.inReplyTo}, ${data.references}::text[], ${data.fromName}, ${data.fromAddress},
            ${data.toAddresses}::text[], ${data.ccAddresses}::text[], ${data.subject},
            ${data.bodyText}, ${data.bodyHtml}, ${data.snippet}, now(), ${data.hasAttachments},
            ${data.sizeBytes}, 'brevo', 'sending', ${data.authorUserId}, ${data.idempotencyKey},
            'new', 'outbound')
    ON CONFLICT ("idempotency_key") WHERE "idempotency_key" IS NOT NULL DO NOTHING
    RETURNING *
  `
  if (inserted[0]) return { row: mapOutbound(inserted[0]), created: true }

  const existing = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_messages" WHERE "idempotency_key" = ${data.idempotencyKey} LIMIT 1
  `
  if (!existing[0]) throw new Error('The message could not be saved. Try again.')
  return { row: mapOutbound(existing[0]), created: false }
}

/** Settles a send: what happened, and whatever the provider called it. */
export async function settleDelivery(
  id: string,
  outcome:
    | { status: 'sent'; providerMessageId: string | null }
    | { status: 'failed'; error: string }
): Promise<void> {
  if (outcome.status === 'sent') {
    await prisma.$executeRaw`
      UPDATE "uin_messages"
         SET "delivery_status" = 'sent',
             "delivery_error" = NULL,
             "provider_message_id" = ${outcome.providerMessageId},
             "sent_at" = now()
       WHERE "id" = ${id}
    `
    return
  }
  await prisma.$executeRaw`
    UPDATE "uin_messages"
       SET "delivery_status" = 'failed',
           "delivery_error" = ${outcome.error.slice(0, 2000)}
     WHERE "id" = ${id}
  `
}

/** Records what became of the copy filed in the Sent folder. A failure here is
 *  recorded and never raised - the email has already gone (D4). */
export async function recordAppendOutcome(
  id: string,
  outcome:
    | { status: 'appended'; folder: string; uid: number | null }
    | { status: 'failed'; error: string }
    | { status: 'skipped' }
): Promise<void> {
  if (outcome.status === 'appended') {
    await prisma.$executeRaw`
      UPDATE "uin_messages"
         SET "append_status" = 'appended',
             "append_error" = NULL,
             "imap_folder" = ${outcome.folder},
             "imap_uid" = ${outcome.uid === null ? null : String(outcome.uid)}::bigint
       WHERE "id" = ${id}
    `
    return
  }
  await prisma.$executeRaw`
    UPDATE "uin_messages"
       SET "append_status" = ${outcome.status},
           "append_error" = ${outcome.status === 'failed' ? outcome.error.slice(0, 2000) : null}
     WHERE "id" = ${id}
  `
}

/** Puts a failed message back to 'sending' so it can be tried again, but only
 *  if it really did fail - a retry that races a send in flight would be a
 *  second email. */
export async function reopenForRetry(id: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "uin_messages" SET "delivery_status" = 'sending', "delivery_error" = NULL
     WHERE "id" = ${id} AND "direction" = 'out' AND "delivery_status" = 'failed'
    RETURNING "id"
  `
  return rows.length > 0
}

export async function getMessage(id: string): Promise<OutboundMessageRow | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_messages" WHERE "id" = ${id}
  `
  return rows[0] ? mapOutbound(rows[0]) : null
}

/** The message a reply answers: the newest inbound one on the thread, or the
 *  newest of any kind if the conversation has only ever gone one way. */
export async function newestMessageOnThread(
  threadId: string,
  direction?: 'in' | 'out'
): Promise<QuotableMessage | null> {
  const rows = direction
    ? await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT * FROM "uin_messages"
         WHERE "thread_id" = ${threadId} AND "direction" = ${direction}
         ORDER BY "sent_at" DESC LIMIT 1
      `
    : await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT * FROM "uin_messages"
         WHERE "thread_id" = ${threadId} AND "direction" <> 'note'
         ORDER BY "sent_at" DESC LIMIT 1
      `
  return rows[0] ? mapQuotable(rows[0]) : null
}

export type QuotableMessage = {
  id: string
  messageIdHeader: string | null
  references: string[]
  fromName: string | null
  fromAddress: string | null
  replyTo: string | null
  toAddresses: string[]
  ccAddresses: string[]
  subject: string | null
  bodyText: string | null
  bodyHtml: string | null
  sentAt: Date
  direction: 'in' | 'out' | 'note'
}

function mapQuotable(r: Record<string, unknown>): QuotableMessage {
  return {
    id: r.id as string,
    messageIdHeader: (r.message_id_header as string | null) ?? null,
    references: (r.references_header as string[] | null) ?? [],
    fromName: (r.from_name as string | null) ?? null,
    fromAddress: (r.from_address as string | null) ?? null,
    // Stored on the inbound row by the sync engine when the sender set one.
    replyTo: (r.reply_to as string | null) ?? null,
    toAddresses: (r.to_addresses as string[] | null) ?? [],
    ccAddresses: (r.cc_addresses as string[] | null) ?? [],
    subject: (r.subject as string | null) ?? null,
    bodyText: (r.body_text as string | null) ?? null,
    bodyHtml: (r.body_html as string | null) ?? null,
    sentAt: r.sent_at as Date,
    direction: r.direction as 'in' | 'out' | 'note',
  }
}

export async function getQuotableMessage(id: string): Promise<QuotableMessage | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_messages" WHERE "id" = ${id}
  `
  return rows[0] ? mapQuotable(rows[0]) : null
}

export type ThreadRow = {
  id: string
  inboxId: string | null
  channel: string
  /** Set when the conversation belongs to another module's channel, along with
   *  that module's own id for it. Null on email, which is ours. */
  providerModule: string | null
  externalId: string | null
  subject: string | null
  subjectNormalised: string | null
  status: string
}

export async function getThread(id: string): Promise<ThreadRow | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "id", "inbox_id", "channel", "provider_module", "external_id",
           "subject", "subject_normalised", "status"
      FROM "uin_threads" WHERE "id" = ${id}
  `
  const r = rows[0]
  if (!r) return null
  return {
    id: r.id as string,
    inboxId: (r.inbox_id as string | null) ?? null,
    channel: r.channel as string,
    providerModule: (r.provider_module as string | null) ?? null,
    externalId: (r.external_id as string | null) ?? null,
    subject: (r.subject as string | null) ?? null,
    subjectNormalised: (r.subject_normalised as string | null) ?? null,
    status: r.status as string,
  }
}

/** An attachment on a message we are sending. No IMAP part - the bytes came
 *  from the media library or from an upload, and are already in storage. */
export async function insertOutboundAttachment(data: {
  messageId: string
  filename: string
  contentType: string | null
  sizeBytes: number
  mediaKey: string | null
  mediaProvider: string | null
  mediaUrl: string | null
}): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "uin_attachments"
      ("message_id", "filename", "content_type", "size_bytes", "media_key",
       "media_provider", "media_url", "fetched_at")
    VALUES (${data.messageId}, ${data.filename}, ${data.contentType}, ${data.sizeBytes},
            ${data.mediaKey}, ${data.mediaProvider}, ${data.mediaUrl}, now())
    RETURNING "id"
  `
  return rows[0]!.id
}

/**
 * A soft pointer from a conversation to a record in another module (D12).
 *
 * Deliberately no foreign key: the module that owns the record can be
 * uninstalled, and a link to something that has gone must degrade to a label
 * rather than break the thread it is attached to.
 */
export async function recordLink(data: {
  threadId: string | null
  personId: string | null
  moduleName: string
  recordType: string
  recordId: string
  label: string
  confidence: number
  linkedBy: 'auto' | 'user'
}): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "uin_record_links"
      ("thread_id", "person_id", "module_name", "record_type", "record_id",
       "label", "confidence", "linked_by")
    VALUES (${data.threadId}, ${data.personId}, ${data.moduleName}, ${data.recordType},
            ${data.recordId}, ${data.label}, ${data.confidence}, ${data.linkedBy})
    ON CONFLICT DO NOTHING
  `
}

/** Starts a conversation that begins with us writing to somebody (D12). */
export async function createOutboundThread(data: {
  inboxId: string
  subject: string | null
  subjectNormalised: string
  preview: string | null
}): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "uin_threads"
      ("inbox_id", "channel", "subject", "subject_normalised", "preview",
       "last_message_at", "last_direction", "unread", "message_count")
    VALUES (${data.inboxId}, 'email', ${data.subject}, ${data.subjectNormalised},
            ${data.preview}, now(), 'out', false, 0)
    RETURNING "id"
  `
  return rows[0]!.id
}

// ---------------------------------------------------------------------------
// Reading it (S5): the tabs, the list, one conversation, and search.
//
// Two rules run through every query below and neither is negotiable:
//
//   The access filter goes INSIDE the SQL, never over the results. A snippet
//   from accounts@ appearing in somebody's search results is the same breach as
//   letting them open accounts@, and filtering afterwards means the rows were
//   fetched, counted and paginated before anybody asked whether they were
//   allowed (E17). Every function here takes the visible inbox ids and folds
//   them into the WHERE clause.
//
//   The search expression is spelled EXACTLY as migrations/004_ui.sql writes
//   it. Postgres matches an expression index by the text of the expression, so
//   a stray space or a reordered field silently turns search into a sequential
//   scan of every email the site holds.
// ---------------------------------------------------------------------------

/** The search expression, in one place, shared by the index and the query. */
const SEARCH_VECTOR = Prisma.sql`to_tsvector('english',
            coalesce("subject", '') || ' ' ||
            coalesce("from_name", '') || ' ' ||
            coalesce("from_address", '') || ' ' ||
            coalesce("body_text", ''))`

export type ThreadListFilters = {
  /** Inbox ids this user may read, already resolved. Empty means none. */
  inboxIds: string[]
  /** Whether they may also see conversations that landed in no inbox at all -
   *  true only for somebody who can administer the whole thing, because an
   *  unrouted message is the most private case there is. */
  includeUnrouted: boolean
  /** Channels owned by another module that this reader may see, by module name.
   *  A chat or an enquiry is in no inbox, so the inbox guest lists say nothing
   *  about it - the owning module's own permission does. */
  providerModules?: string[]
  /** One inbox chosen in the tabs, or null for everything they may see. */
  inboxId?: string | null
  /** Only the conversations that landed in no inbox at all. */
  unroutedOnly?: boolean
  /** One channel chosen in the tabs, by the module that owns it. */
  providerModule?: string | null
  status?: ThreadStatusFilter
  unreadOnly?: boolean
  /** A user id, or 'unassigned', or null for "do not filter". */
  assignee?: string | null
  search?: string | null
  page: number
  perPage: number
}

export type ThreadStatusFilter = 'open' | 'snoozed' | 'done' | 'all'

export type ThreadListRow = {
  id: string
  inboxId: string | null
  channel: string
  providerModule: string | null
  subject: string | null
  preview: string | null
  status: string
  snoozeUntil: Date | null
  assigneeUserId: string | null
  lastMessageAt: Date | null
  lastDirection: string | null
  unread: boolean
  messageCount: number
  /** The other party. Taken from their newest message to us where there is
   *  one, because that is the only place their NAME appears - our own replies
   *  carry an address and nothing else - and from the newest thing we sent them
   *  otherwise, which is all there is to go on. */
  participantName: string | null
  participantAddress: string | null
  hasAttachments: boolean
}

/** The access half of the WHERE clause, built once and reused by the list, the
 *  count and the unread tallies so the three can never disagree. */
function visibilityClause(
  inboxIds: string[],
  includeUnrouted: boolean,
  providerModules: string[] = [],
): Prisma.Sql | null {
  const parts: Prisma.Sql[] = []
  if (inboxIds.length > 0) {
    parts.push(Prisma.sql`t."inbox_id" IN (${Prisma.join(inboxIds)})`)
  }
  if (includeUnrouted) {
    // Mail that reached the account and matched none of the site's addresses.
    // A chat or an enquiry also sits in no inbox and must NOT fall in here:
    // "not filed" means an email nobody could place, and a channel that never
    // had an address to be placed by is a different thing entirely.
    parts.push(Prisma.sql`(t."inbox_id" IS NULL AND t."provider_module" IS NULL)`)
  }
  if (providerModules.length > 0) {
    parts.push(Prisma.sql`t."provider_module" IN (${Prisma.join(providerModules)})`)
  }
  // Nothing visible at all. The caller returns an empty page rather than
  // running a query whose WHERE clause would be empty and therefore true.
  if (parts.length === 0) return null
  return Prisma.sql`(${Prisma.join(parts, ' OR ')})`
}

function filterClauses(f: ThreadListFilters): Prisma.Sql[] {
  const where: Prisma.Sql[] = []
  if (f.unroutedOnly) {
    where.push(Prisma.sql`t."inbox_id" IS NULL AND t."provider_module" IS NULL`)
  } else if (f.providerModule) {
    where.push(Prisma.sql`t."provider_module" = ${f.providerModule}`)
  } else if (f.inboxId) {
    where.push(Prisma.sql`t."inbox_id" = ${f.inboxId}`)
  }
  if (f.status && f.status !== 'all') where.push(Prisma.sql`t."status" = ${f.status}`)
  if (f.unreadOnly) where.push(Prisma.sql`t."unread" = true`)
  if (f.assignee === 'unassigned') where.push(Prisma.sql`t."assignee_user_id" IS NULL`)
  else if (f.assignee) where.push(Prisma.sql`t."assignee_user_id" = ${f.assignee}`)
  const q = f.search?.trim()
  if (q) {
    // Correlated on purpose, and measured rather than assumed: on 14,000
    // conversations and 31,000 messages with ordinary varied text, this plans
    // as a bitmap scan of uin_messages_search_idx feeding a semi join, and
    // answers in 32ms. Rewriting it as an uncorrelated `t.id IN (SELECT ...)`
    // measured the same to within noise, so the shape S5 shipped stands.
    //
    // A warning for whoever measures this next: a fixture where every message
    // carries the same words makes the search term match half the table, and
    // Postgres then correctly ignores the index and scans - which reads exactly
    // like a missing index and is nothing of the kind. Vary the bodies, or the
    // measurement will tell you the opposite of the truth.
    //
    // E17: this is ANDed with the visibility clause inside one WHERE, so a
    // conversation in an inbox the reader cannot open is never fetched, never
    // counted and never paged.
    where.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "uin_messages" ms
       WHERE ms."thread_id" = t."id"
         AND ${SEARCH_VECTOR} @@ websearch_to_tsquery('english', ${q})
    )`)
  }
  return where
}

/** The order every list of conversations is drawn in. Written once because the
 *  page and the join below both have to agree about it. */
const THREAD_LIST_ORDER = Prisma.sql`t."last_message_at" DESC NULLS LAST, t."id" DESC`

/**
 * The columns and the participant join every list of conversations needs,
 * written once so the inbox list and a person's own page cannot drift apart.
 * See ThreadListRow for why the participant comes from their newest INBOUND
 * message rather than simply the newest.
 *
 * The page is taken BEFORE the join, which is not decoration.
 *
 * Written the obvious way round - join every matching conversation to its
 * newest message, then sort and keep 25 - the participant lookup runs once per
 * matching row rather than once per row shown. Measured on 14,000
 * conversations, an ordinary All view spent 86ms and read 30,000 pages to
 * return 25 rows, and that cost grows with the size of the mailbox rather than
 * with the size of the page: the same screen on a site with ten times the mail
 * would take ten times as long, for ever, on every page load.
 *
 * So the inner query narrows to the page first - which is an index scan, since
 * the ordering is the index's own - and only those rows are joined.
 */
function threadListQuery(where: Prisma.Sql[], limit: number, offset: number): Prisma.Sql {
  return Prisma.sql`
    SELECT t."id", t."inbox_id", t."channel", t."provider_module", t."subject",
           t."preview", t."status", t."snooze_until", t."assignee_user_id",
           t."last_message_at", t."last_direction", t."unread", t."message_count",
           lm."from_name"        AS "last_from_name",
           lm."from_address"     AS "last_from_address",
           lm."from_phone"       AS "last_from_phone",
           lm."to_addresses"     AS "last_to",
           lm."direction"        AS "last_direction_message",
           lm."has_attachments"  AS "last_has_attachments"
      FROM (
        SELECT t.* FROM "uin_threads" t
         WHERE ${Prisma.join(where, ' AND ')}
         ORDER BY ${THREAD_LIST_ORDER}
         LIMIT ${limit} OFFSET ${offset}
      ) t
      LEFT JOIN LATERAL (
        SELECT m."from_name", m."from_address", m."from_phone", m."to_addresses", m."direction",
               m."has_attachments"
          FROM "uin_messages" m
         WHERE m."thread_id" = t."id" AND m."direction" <> 'note'
         ORDER BY (m."direction" = 'in') DESC, m."sent_at" DESC
         LIMIT 1
      ) lm ON true
     ORDER BY ${THREAD_LIST_ORDER}`
}

function mapThreadListRow(r: Record<string, unknown>): ThreadListRow {
  const direction = (r.last_direction_message as string | null) ?? null
  const to = (r.last_to as string[] | null) ?? []
  const inbound = direction !== 'out'
  return {
    id: r.id as string,
    inboxId: (r.inbox_id as string | null) ?? null,
    channel: r.channel as string,
    providerModule: (r.provider_module as string | null) ?? null,
    subject: (r.subject as string | null) ?? null,
    preview: (r.preview as string | null) ?? null,
    status: r.status as string,
    snoozeUntil: (r.snooze_until as Date | null) ?? null,
    assigneeUserId: (r.assignee_user_id as string | null) ?? null,
    lastMessageAt: (r.last_message_at as Date | null) ?? null,
    lastDirection: (r.last_direction as string | null) ?? null,
    unread: !!r.unread,
    messageCount: Number(r.message_count ?? 0),
    participantName: inbound ? ((r.last_from_name as string | null) ?? null) : null,
    // A caller has a number where a correspondent has an address, and the row
    // says whichever of the two there is - "Unknown sender" beside a phone
    // conversation whose number we are holding would be a plain untruth.
    participantAddress: inbound
      ? ((r.last_from_address as string | null) ?? (r.last_from_phone as string | null) ?? null)
      : (to[0] ?? (r.last_from_phone as string | null) ?? null),
    hasAttachments: !!r.last_has_attachments,
  }
}

export async function listThreads(f: ThreadListFilters): Promise<ThreadListRow[]> {
  const visible = visibilityClause(f.inboxIds, f.includeUnrouted, f.providerModules ?? [])
  if (!visible) return []
  const where = [visible, ...filterClauses(f)]
  const offset = Math.max(0, (f.page - 1) * f.perPage)
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>(
    threadListQuery(where, f.perPage, offset),
  )
  return rows.map(mapThreadListRow)
}

export async function countThreads(f: ThreadListFilters): Promise<number> {
  const visible = visibilityClause(f.inboxIds, f.includeUnrouted, f.providerModules ?? [])
  if (!visible) return 0
  const where = [visible, ...filterClauses(f)]
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS "count" FROM "uin_threads" t
     WHERE ${Prisma.join(where, ' AND ')}
  `
  return Number(rows[0]?.count ?? 0)
}

/** Unread conversations per inbox, for the numbers on the tabs. Keyed by
 *  inbox id, with the empty string standing for "landed in no inbox". */
export async function unreadCounts(
  inboxIds: string[],
  includeUnrouted: boolean,
  providerModules: string[] = [],
): Promise<Record<string, number>> {
  const visible = visibilityClause(inboxIds, includeUnrouted, providerModules)
  if (!visible) return {}
  const rows = await prisma.$queryRaw<{ key: string | null; count: bigint }[]>`
    SELECT COALESCE('m:' || t."provider_module", t."inbox_id") AS "key",
           COUNT(*)::bigint AS "count"
      FROM "uin_threads" t
     WHERE ${visible} AND t."unread" = true AND t."status" <> 'done'
     GROUP BY COALESCE('m:' || t."provider_module", t."inbox_id")
  `
  const out: Record<string, number> = {}
  for (const r of rows) out[r.key ?? ''] = Number(r.count)
  return out
}

/**
 * How many conversations sit under each status, for the numbers on the status
 * tabs.
 *
 * Everything the reader has already chosen counts - the inbox, the search, who
 * it is assigned to - and only the status itself is left out of the WHERE,
 * because the whole point of the numbers is to say what is waiting behind the
 * tabs somebody is NOT looking at. One grouped query rather than one per tab,
 * so a fourth status later costs nothing.
 */
export async function statusCounts(f: ThreadListFilters): Promise<Record<string, number>> {
  const visible = visibilityClause(f.inboxIds, f.includeUnrouted, f.providerModules ?? [])
  if (!visible) return {}
  const where = [visible, ...filterClauses({ ...f, status: 'all' })]
  const rows = await prisma.$queryRaw<{ status: string; count: bigint }[]>`
    SELECT t."status" AS "status", COUNT(*)::bigint AS "count"
      FROM "uin_threads" t
     WHERE ${Prisma.join(where, ' AND ')}
     GROUP BY t."status"
  `
  const out: Record<string, number> = {}
  let all = 0
  for (const r of rows) {
    out[r.status] = Number(r.count)
    all += Number(r.count)
  }
  out.all = all
  return out
}

export type ThreadDetail = {
  id: string
  inboxId: string | null
  channel: string
  providerModule: string | null
  externalId: string | null
  subject: string | null
  subjectNormalised: string | null
  status: string
  snoozeUntil: Date | null
  assigneeUserId: string | null
  personId: string | null
  unread: boolean
  messageCount: number
  lastMessageAt: Date | null
  createdAt: Date
}

export async function getThreadDetail(id: string): Promise<ThreadDetail | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_threads" WHERE "id" = ${id}
  `
  const r = rows[0]
  if (!r) return null
  return {
    id: r.id as string,
    inboxId: (r.inbox_id as string | null) ?? null,
    channel: r.channel as string,
    providerModule: (r.provider_module as string | null) ?? null,
    externalId: (r.external_id as string | null) ?? null,
    subject: (r.subject as string | null) ?? null,
    subjectNormalised: (r.subject_normalised as string | null) ?? null,
    status: r.status as string,
    snoozeUntil: (r.snooze_until as Date | null) ?? null,
    assigneeUserId: (r.assignee_user_id as string | null) ?? null,
    personId: (r.person_id as string | null) ?? null,
    unread: !!r.unread,
    messageCount: Number(r.message_count ?? 0),
    lastMessageAt: (r.last_message_at as Date | null) ?? null,
    createdAt: r.created_at as Date,
  }
}

export type ThreadMessageRow = {
  id: string
  direction: 'in' | 'out' | 'note'
  channel: string
  fromName: string | null
  fromAddress: string | null
  /** The other party's number, on the channels that have one instead of an
   *  address. Never folded into fromAddress: that column is what email
   *  identities are matched on. */
  fromPhone: string | null
  /** What the sender asked replies to go to, when they asked for anything. It
   *  beats From, which is the entire purpose of the header (E13). */
  replyTo: string | null
  toAddresses: string[]
  ccAddresses: string[]
  subject: string | null
  bodyText: string | null
  /** Whether there is HTML to render. The markup itself is never handed to the
   *  page - it is fetched into a sandboxed frame of its own (E16). */
  hasHtml: boolean
  /** How many pictures are sitting in the message waiting to be asked for. The
   *  count is enough for the screen; the addresses stay on the server. */
  remoteImages: number
  snippet: string | null
  sentAt: Date
  hasAttachments: boolean
  autoKind: string | null
  deliveryStatus: string | null
  deliveryError: string | null
  appendStatus: string | null
  /** What became of it after it left, when the site is watching for that. All
   *  null on every message a site with receipts switched off ever sends. */
  deliveredAt: Date | null
  openedAt: Date | null
  lastOpenAt: Date | null
  openCount: number
  /** 'human' | 'proxy' | 'receipt'. A proxy open is the recipient's mail app
   *  fetching the picture, not the recipient. */
  openSource: string | null
  bouncedAt: Date | null
  bounceKind: string | null
  bounceDetail: string | null
  authorUserId: string | null
  source: string
}

function mapThreadMessage(r: Record<string, unknown>): ThreadMessageRow {
  const html = (r.body_html as string | null) ?? null
  return {
    id: r.id as string,
    direction: r.direction as 'in' | 'out' | 'note',
    channel: r.channel as string,
    fromName: (r.from_name as string | null) ?? null,
    fromAddress: (r.from_address as string | null) ?? null,
    fromPhone: (r.from_phone as string | null) ?? null,
    replyTo: (r.reply_to as string | null) ?? null,
    toAddresses: (r.to_addresses as string[] | null) ?? [],
    ccAddresses: (r.cc_addresses as string[] | null) ?? [],
    subject: (r.subject as string | null) ?? null,
    bodyText: (r.body_text as string | null) ?? null,
    hasHtml: !!html && html.trim().length > 0,
    remoteImages: remoteImageUrls(html).length,
    snippet: (r.snippet as string | null) ?? null,
    sentAt: r.sent_at as Date,
    hasAttachments: !!r.has_attachments,
    autoKind: (r.auto_kind as string | null) ?? null,
    deliveryStatus: (r.delivery_status as string | null) ?? null,
    deliveryError: (r.delivery_error as string | null) ?? null,
    appendStatus: (r.append_status as string | null) ?? null,
    deliveredAt: (r.delivered_at as Date | null) ?? null,
    openedAt: (r.opened_at as Date | null) ?? null,
    lastOpenAt: (r.last_open_at as Date | null) ?? null,
    openCount: Number(r.open_count ?? 0),
    openSource: (r.open_source as string | null) ?? null,
    bouncedAt: (r.bounced_at as Date | null) ?? null,
    bounceKind: (r.bounce_kind as string | null) ?? null,
    bounceDetail: (r.bounce_detail as string | null) ?? null,
    authorUserId: (r.author_user_id as string | null) ?? null,
    source: r.source as string,
  }
}

/** Every message on a conversation, oldest first - the order somebody reads a
 *  story in, and the order the composer quotes from. */
export async function listThreadMessages(threadId: string): Promise<ThreadMessageRow[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_messages"
     WHERE "thread_id" = ${threadId}
     ORDER BY "sent_at" ASC, "created_at" ASC
  `
  return rows.map(mapThreadMessage)
}

/** Attachments for a whole conversation in one query, so a thread with twelve
 *  messages does not make twelve round trips. */
export async function attachmentsForThread(threadId: string): Promise<AttachmentRow[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    ${ATTACHMENT_SELECT}
     WHERE m."thread_id" = ${threadId}
     ORDER BY a."created_at" ASC
  `
  return rows.map(mapAttachment)
}

/** The HTML of one message, with the inbox it belongs to so the route serving
 *  it can check who is asking. Kept separate from the thread query because the
 *  markup is large and only ever wanted one message at a time. */
export async function getMessageHtml(id: string): Promise<{
  html: string | null
  text: string | null
  inboxId: string | null
  // Which channel owns it, when another module does. A message with neither an
  // inbox nor a channel is an email nobody could place, which is a different
  // question about who may read it - see threadAccessKind in lib/access.ts.
  providerModule: string | null
  subject: string | null
} | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT m."body_html", m."body_text", m."subject", m."inbox_id",
           t."inbox_id" AS "thread_inbox_id", t."provider_module"
      FROM "uin_messages" m
      JOIN "uin_threads" t ON t."id" = m."thread_id"
     WHERE m."id" = ${id}
  `
  const r = rows[0]
  if (!r) return null
  return {
    html: (r.body_html as string | null) ?? null,
    text: (r.body_text as string | null) ?? null,
    // An outbound message carries the inbox it was sent from; an inbound one
    // inherits its thread's.
    inboxId: ((r.inbox_id as string | null) ?? (r.thread_inbox_id as string | null)) ?? null,
    providerModule: (r.provider_module as string | null) ?? null,
    subject: (r.subject as string | null) ?? null,
  }
}

// ---------------------------------------------------------------------------
// Working through it: assign, snooze, done, read, notes.
//
// Every one of these writes a uin_events row beside the change, because "who
// marked this done and when" is the question somebody asks a fortnight later
// and a bare column cannot answer.
// ---------------------------------------------------------------------------

export type ThreadEventKind =
  | 'assigned'
  | 'snoozed'
  | 'status'
  | 'note'
  | 'mentioned'
  | 'linked'
  | 'unlinked'
  | 'merged'

export async function recordEvent(
  threadId: string,
  userId: string | null,
  kind: ThreadEventKind,
  detail: Record<string, unknown> | null = null,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "uin_events" ("thread_id", "user_id", "kind", "detail")
    VALUES (${threadId}, ${userId}, ${kind}, ${detail === null ? Prisma.DbNull : detail}::jsonb)
  `
}

export type ThreadEventRow = {
  id: string
  userId: string | null
  kind: string
  detail: Record<string, unknown> | null
  createdAt: Date
}

export async function listThreadEvents(threadId: string): Promise<ThreadEventRow[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "id", "user_id", "kind", "detail", "created_at"
      FROM "uin_events"
     WHERE "thread_id" = ${threadId}
     ORDER BY "created_at" ASC
  `
  return rows.map((r) => ({
    id: r.id as string,
    userId: (r.user_id as string | null) ?? null,
    kind: r.kind as string,
    detail: (r.detail as Record<string, unknown> | null) ?? null,
    createdAt: r.created_at as Date,
  }))
}

export async function setThreadRead(threadId: string, unread: boolean): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "uin_threads" SET "unread" = ${unread}, "updated_at" = now() WHERE "id" = ${threadId}
  `
}

export async function assignThread(threadId: string, userId: string | null): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "uin_threads"
       SET "assignee_user_id" = ${userId}, "updated_at" = now()
     WHERE "id" = ${threadId}
  `
}

/** Status and snooze move together: a conversation put to sleep is 'snoozed'
 *  until its time comes, and waking it clears the stamp. Leaving one without
 *  the other is how a conversation disappears for ever. */
export async function setThreadStatus(
  threadId: string,
  status: 'open' | 'snoozed' | 'done',
  snoozeUntil: Date | null,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "uin_threads"
       SET "status" = ${status},
           "snooze_until" = ${status === 'snoozed' ? snoozeUntil : null},
           "updated_at" = now()
     WHERE "id" = ${threadId}
  `
}

/** Conversations whose snooze has elapsed, opened again. Cheap enough to run
 *  on the way into the list, which is the only moment anybody would notice. */
export async function wakeDueThreads(): Promise<number> {
  return prisma.$executeRaw`
    UPDATE "uin_threads"
       SET "status" = 'open', "snooze_until" = NULL, "updated_at" = now()
     WHERE "status" = 'snoozed' AND "snooze_until" IS NOT NULL AND "snooze_until" <= now()
  `
}

/**
 * An internal note: visible to colleagues, never sent anywhere.
 *
 * Deliberately does NOT touch the thread's last_message_at or its unread flag.
 * A note is us talking among ourselves - bumping the conversation to the top of
 * everybody's list and marking it unread would make our own remarks look like
 * the customer had written again.
 */
export async function insertNote(data: {
  threadId: string
  channel: string
  bodyHtml: string
  bodyText: string
  authorUserId: string
}): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "uin_messages"
      ("thread_id", "direction", "channel", "body_html", "body_text", "snippet",
       "sent_at", "source", "author_user_id")
    VALUES (${data.threadId}, 'note', ${data.channel}, ${data.bodyHtml}, ${data.bodyText},
            ${data.bodyText.slice(0, 200)}, now(), 'manual', ${data.authorUserId})
    RETURNING "id"
  `
  return rows[0]!.id
}

// ---------------------------------------------------------------------------
// Drafts.
//
// READING one now follows the address it is filed on, exactly as every other
// message on that address does: if you can read accounts@, you can read what is
// half-written to accounts@. That is a deliberate reversal of the original rule
// (author-only, see the header of migrations/013_drafts.sql, which describes
// how this used to work and is left as written because an applied migration is
// never edited). A shared inbox is shared, and a colleague who is off sick
// should not take the supplier's half-answered question with them.
//
// A draft with no address on it answers a conversation another module owns.
// There is no guest list to grant sight through, so it stays with its author.
//
// WRITING follows the same address, but through the narrower list: editing,
// discarding and sending belong to whoever may SEND from the inbox the draft is
// filed on, not to everybody who may read it. saveDraft, deleteDraft and the
// send route all AND that into their WHERE clause, so a draft on an address this
// person cannot send as is never touched. Authorship is not rewritten when
// somebody else finishes one - the row keeps the name of whoever started it, and
// the reply leaves as the inbox regardless. The pure statement of both halves,
// with the tests, is canReadDraft/canEditDraft in lib/drafts.ts - change one and
// change the other.
//
// The visible-inbox list goes into the SQL for the same reason it does
// everywhere else in this file (E17): the rule is ANDed into the query rather
// than applied to the rows afterwards, so a draft on an address this reader
// cannot open is never fetched and never counted on the tabs.
// ---------------------------------------------------------------------------

function mapDraft(r: Record<string, unknown>): Draft {
  const mode = r.mode as DraftMode
  return {
    id: r.id as string,
    authorUserId: r.author_user_id as string,
    inboxId: (r.inbox_id as string | null) ?? null,
    threadId: (r.thread_id as string | null) ?? null,
    mode: DRAFT_MODES.includes(mode) ? mode : 'new',
    to: (r.to_addresses as string[] | null) ?? [],
    cc: (r.cc_addresses as string[] | null) ?? [],
    subject: (r.subject as string | null) ?? null,
    body: (r.body as string | null) ?? '',
    // jsonb comes back parsed, and can be any shape at all if somebody has been
    // at the table by hand. Anything that is not a list of files is no files.
    attachments: Array.isArray(r.attachments) ? (r.attachments as DraftAttachment[]) : [],
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  }
}

/** Anybody's draft on an address this person can read, or this person's own on
 *  a conversation another module owns (which has no address to read through).
 *  The SQL twin of canReadDraft in lib/drafts.ts. */
function draftScope(userId: string, inboxIds: string[]): Prisma.Sql {
  return Prisma.sql`(d."inbox_id" = ANY(${inboxIds}::text[])
      OR (d."inbox_id" IS NULL AND d."author_user_id" = ${userId}))`
}

/** Whose draft this person may CHANGE: their own, or one filed on an address
 *  they may send from. The SQL twin of canEditDraft in lib/drafts.ts. */
function editScope(userId: string, replyableInboxIds: string[]): Prisma.Sql {
  return Prisma.sql`("author_user_id" = ${userId}
      OR ("inbox_id" IS NOT NULL AND "inbox_id" = ANY(${replyableInboxIds}::text[])))`
}

export async function listDrafts(userId: string, inboxIds: string[]): Promise<Draft[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT d.* FROM "uin_drafts" d
     WHERE ${draftScope(userId, inboxIds)}
     ORDER BY d."updated_at" DESC
     LIMIT 200
  `
  return rows.map(mapDraft)
}

/** How many are waiting, for the number on the Drafts tab. */
export async function countDrafts(userId: string, inboxIds: string[]): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS "count" FROM "uin_drafts" d
     WHERE ${draftScope(userId, inboxIds)}
  `
  return Number(rows[0]?.count ?? 0)
}

// ---------------------------------------------------------------------------
// Sent.
//
// One row per message that left, across every address - which is what a Sent
// folder has meant since before any of this existed, and the answer to "did that
// quote actually go, and when". Messages rather than conversations, because a
// long thread somebody has answered four times is four things sent, and a list
// that showed it once would be a list of conversations wearing a Sent label.
//
// Internal notes are not sent to anybody, so they are not here. The access rule
// is the same one the conversation list runs (E17): the visibility clause is
// ANDed into the query rather than applied to the rows afterwards, so a reply
// somebody sent from an address this reader cannot open is never fetched.
// ---------------------------------------------------------------------------

export type SentMessageRow = {
  id: string
  threadId: string
  /** Which address it went out as. The message carries its own, and falls back
   *  to the conversation's for anything sent before that was recorded. */
  inboxId: string | null
  subject: string | null
  preview: string | null
  toAddresses: string[]
  sentAt: Date
  hasAttachments: boolean
  deliveryStatus: string | null
  openedAt: Date | null
  bouncedAt: Date | null
  bounceKind: string | null
  authorUserId: string | null
}

/**
 * What belongs on the Sent list, and to whom.
 *
 * Ordinary outbound mail, on a conversation this person may read - that half
 * has not changed. The second half is colleague post: a message one address
 * here sent to another is filed as INBOUND on the colleague it was addressed
 * to, because that is what it is to them, and the sender would otherwise watch
 * their own message disappear the moment it was delivered. It is still
 * something they sent, so it is listed for whoever may read the address it went
 * out as - which is a different question from whether they may read the
 * colleague's inbox it landed in, and the right one: it is their own writing.
 */
function sentWhere(
  inboxIds: string[],
  includeUnrouted: boolean,
  providerModules: string[],
): Prisma.Sql | null {
  const visible = visibilityClause(inboxIds, includeUnrouted, providerModules)
  if (!visible) return null
  const outbound = Prisma.sql`(m."direction" = 'out' AND ${visible})`
  if (inboxIds.length === 0) return outbound
  return Prisma.sql`(${outbound} OR (m."direction" = 'in' AND lower(m."from_address") IN (
    SELECT lower(i."address") FROM "uin_inboxes" i WHERE i."id" IN (${Prisma.join(inboxIds)})
  )))`
}

/** The address a listed message went out as, as an inbox id. Outbound mail
 *  carries it already; colleague post has to be read back off the From line,
 *  because the thread it landed on belongs to the person who received it. */
const SENT_INBOX_ID = Prisma.sql`COALESCE(
  m."inbox_id",
  (SELECT i."id" FROM "uin_inboxes" i WHERE lower(i."address") = lower(m."from_address") LIMIT 1),
  t."inbox_id"
)`

export async function listSentMessages(
  inboxIds: string[],
  includeUnrouted: boolean,
  providerModules: string[],
  page: number,
  perPage: number,
): Promise<SentMessageRow[]> {
  const where = sentWhere(inboxIds, includeUnrouted, providerModules)
  if (!where) return []
  const offset = Math.max(0, (page - 1) * perPage)
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT m."id", m."thread_id", ${SENT_INBOX_ID} AS "inbox_id",
           COALESCE(m."subject", t."subject") AS "subject",
           COALESCE(m."snippet", LEFT(m."body_text", 200)) AS "preview",
           m."to_addresses", m."sent_at", m."has_attachments", m."delivery_status",
           m."opened_at", m."bounced_at", m."bounce_kind", m."author_user_id"
      FROM "uin_messages" m
      JOIN "uin_threads" t ON t."id" = m."thread_id"
     WHERE ${where}
     ORDER BY m."sent_at" DESC, m."id" DESC
     LIMIT ${perPage} OFFSET ${offset}
  `
  return rows.map((r) => ({
    id: r.id as string,
    threadId: r.thread_id as string,
    inboxId: (r.inbox_id as string | null) ?? null,
    subject: (r.subject as string | null) ?? null,
    preview: (r.preview as string | null) ?? null,
    toAddresses: (r.to_addresses as string[] | null) ?? [],
    sentAt: r.sent_at as Date,
    hasAttachments: !!r.has_attachments,
    deliveryStatus: (r.delivery_status as string | null) ?? null,
    openedAt: (r.opened_at as Date | null) ?? null,
    bouncedAt: (r.bounced_at as Date | null) ?? null,
    bounceKind: (r.bounce_kind as string | null) ?? null,
    authorUserId: (r.author_user_id as string | null) ?? null,
  }))
}

export async function countSentMessages(
  inboxIds: string[],
  includeUnrouted: boolean,
  providerModules: string[],
): Promise<number> {
  const where = sentWhere(inboxIds, includeUnrouted, providerModules)
  if (!where) return 0
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS "count"
      FROM "uin_messages" m
      JOIN "uin_threads" t ON t."id" = m."thread_id"
     WHERE ${where}
  `
  return Number(rows[0]?.count ?? 0)
}

/** One draft, and only if it is this person's. Never "one draft, then check" -
 *  a route that forgets the second half hands somebody else's writing out. */
/** One draft, if this person may read it. Whether they may CHANGE it is a
 *  second question - ask canEditDraft, and note that saveDraft and deleteDraft
 *  enforce it themselves regardless of what any screen decided. */
export async function getDraft(
  id: string,
  userId: string,
  inboxIds: string[],
): Promise<Draft | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT d.* FROM "uin_drafts" d
     WHERE d."id" = ${id} AND ${draftScope(userId, inboxIds)}
     LIMIT 1
  `
  return rows[0] ? mapDraft(rows[0]) : null
}

/** Whatever THIS person left under this conversation, which the reply box opens
 *  on. One row at most - the unique index sees to that.
 *
 *  Their own first, and then anybody's on an address they may send from - the
 *  reply box is where a draft gets finished, and a draft only its author can
 *  finish is one that waits for ever when the author is an agent or on leave.
 *  Own-first matters when two people have written on the same conversation:
 *  nobody opens a reply box and finds their own paragraph replaced. */
export async function draftForThread(
  threadId: string,
  userId: string,
  replyableInboxIds: string[],
): Promise<Draft | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_drafts"
     WHERE "thread_id" = ${threadId} AND ${editScope(userId, replyableInboxIds)}
     ORDER BY ("author_user_id" = ${userId}) DESC, "updated_at" DESC
     LIMIT 1
  `
  return rows[0] ? mapDraft(rows[0]) : null
}

export type DraftInput = {
  id?: string | null
  /** Whoever is saving. On a brand new draft this becomes the author; on one
   *  that already exists it is only half of who may touch it, and the row keeps
   *  the name it was started under. */
  authorUserId: string
  /** The inboxes this person may send from - the other half of that rule. */
  replyableInboxIds: string[]
  inboxId: string | null
  threadId: string | null
  mode: DraftMode
  to: string[]
  cc: string[]
  subject: string | null
  body: string
  attachments: DraftAttachment[]
}

/**
 * Saves a draft, over the top of whichever one it already was.
 *
 * Three ways in, and they are all the same row in the end: an id, because the
 * composer already saved once; a conversation, because the reply box only ever
 * has one draft in it; or neither, which is a brand new message. The
 * conversation route conflicts onto the unique index rather than reading first
 * and then writing, so two saves racing each other leave one draft rather than
 * one draft and one lost paragraph.
 */
export async function saveDraft(data: DraftInput): Promise<Draft> {
  if (data.id) {
    const updated = await prisma.$queryRaw<Record<string, unknown>[]>`
      UPDATE "uin_drafts"
         SET "inbox_id"     = ${data.inboxId},
             "mode"         = ${data.mode},
             "to_addresses" = ${data.to}::text[],
             "cc_addresses" = ${data.cc}::text[],
             "subject"      = ${data.subject},
             "body"         = ${data.body},
             "attachments"  = ${JSON.stringify(data.attachments)}::jsonb,
             "updated_at"   = now()
       WHERE "id" = ${data.id} AND ${editScope(data.authorUserId, data.replyableInboxIds)}
      RETURNING *
    `
    if (updated[0]) return mapDraft(updated[0])
    // The draft was discarded, or sent, while this composer had it open. Saving
    // again writes a new one rather than throwing away what is on the screen.
  }

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    INSERT INTO "uin_drafts"
      ("author_user_id", "inbox_id", "thread_id", "mode", "to_addresses",
       "cc_addresses", "subject", "body", "attachments")
    VALUES (${data.authorUserId}, ${data.inboxId}, ${data.threadId}, ${data.mode},
            ${data.to}::text[], ${data.cc}::text[], ${data.subject}, ${data.body},
            ${JSON.stringify(data.attachments)}::jsonb)
    ON CONFLICT ("thread_id", "author_user_id") WHERE "thread_id" IS NOT NULL
    DO UPDATE SET "inbox_id"     = EXCLUDED."inbox_id",
                  "mode"         = EXCLUDED."mode",
                  "to_addresses" = EXCLUDED."to_addresses",
                  "cc_addresses" = EXCLUDED."cc_addresses",
                  "subject"      = EXCLUDED."subject",
                  "body"         = EXCLUDED."body",
                  "attachments"  = EXCLUDED."attachments",
                  "updated_at"   = now()
    RETURNING *
  `
  return mapDraft(rows[0]!)
}

/** Throws one away. Returns whether there was one to throw - a Discard pressed
 *  twice is not an error, and neither is sending a message whose draft another
 *  tab has already tidied up. */
export async function deleteDraft(
  id: string,
  userId: string,
  replyableInboxIds: string[],
): Promise<boolean> {
  const count = await prisma.$executeRaw`
    DELETE FROM "uin_drafts" WHERE "id" = ${id} AND ${editScope(userId, replyableInboxIds)}
  `
  return count > 0
}

/** The draft behind a message that has just gone. Called by the send route
 *  with whatever the composer was carrying, so finishing a draft removes it
 *  from the list without the browser having to remember to ask. */
export async function discardDraftAfterSend(
  id: string | null | undefined,
  userId: string,
  replyableInboxIds: string[],
): Promise<void> {
  if (!id) return
  try {
    await deleteDraft(id, userId, replyableInboxIds)
  } catch (err) {
    // The message has gone. A draft left behind is untidy; a failed send
    // reported to somebody whose email actually left is a lie.
    console.error('[unified-inbox] could not tidy up the draft after sending', err)
  }
}

// ---------------------------------------------------------------------------
// People, organisations and links to the site's own records (S6).
//
// Same rule as everything above: the raw column names live here. Two more that
// are particular to this half of the module:
//
//   A person who lost a merge is KEPT, with merged_into_id set. Merging is the
//   operation most likely to be regretted, and a row that is still there is a
//   row that can be put back; a row that was deleted is an apology.
//
//   Every read of somebody's conversations goes through the same visibility
//   clause the list uses. A person's page is a second way of asking the same
//   question as the search box, and it must not be a second answer (E17).
// ---------------------------------------------------------------------------

function mapPerson(r: Record<string, unknown>): Person {
  return {
    id: r.id as string,
    displayName: (r.display_name as string | null) ?? null,
    primaryEmail: (r.primary_email as string | null) ?? null,
    organisationId: (r.organisation_id as string | null) ?? null,
    organisationName: (r.organisation_name as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    mergedIntoId: (r.merged_into_id as string | null) ?? null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  }
}

const PERSON_SELECT = Prisma.sql`
  p."id", p."display_name", p."primary_email", p."organisation_id", p."notes",
  p."merged_into_id", p."created_at", p."updated_at", o."name" AS organisation_name`

/** One person, following a merge to whoever they were merged into. Somebody
 *  holding a link to a person from before a merge should land on the person who
 *  now holds their mail, not on an empty page.
 *
 *  The depth limit is not decoration. Merging refuses to point at somebody who
 *  has themselves been merged, so a loop should be impossible - but this runs
 *  while a page is rendering, and a row that got into a state nobody planned
 *  must come back as "not found" rather than as a hung request. */
export async function getPerson(id: string, depth = 0): Promise<Person | null> {
  if (depth > 8) {
    console.error(`[unified-inbox] person ${id} is part of a merge chain that goes round in circles`)
    return null
  }
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT ${PERSON_SELECT}
      FROM "uin_people" p
      LEFT JOIN "uin_organisations" o ON o."id" = p."organisation_id"
     WHERE p."id" = ${id}
  `
  const person = rows[0] ? mapPerson(rows[0]) : null
  if (person?.mergedIntoId && person.mergedIntoId !== id) {
    return getPerson(person.mergedIntoId, depth + 1)
  }
  return person
}

export type PersonListRow = Person & { identityCount: number; threadCount: number }

/** The people directory: everybody we have met, newest first, minus anybody who
 *  lost a merge. */
export async function listPeople(opts: {
  search?: string | null
  page: number
  perPage: number
}): Promise<{ rows: PersonListRow[]; total: number }> {
  const term = opts.search?.trim()
  const where = term
    ? Prisma.sql`p."merged_into_id" IS NULL AND (
        p."display_name" ILIKE ${`%${term}%`}
        OR p."primary_email" ILIKE ${`%${term}%`}
        OR o."name" ILIKE ${`%${term}%`}
        OR EXISTS (SELECT 1 FROM "uin_person_identities" i
                    WHERE i."person_id" = p."id" AND i."value" ILIKE ${`%${term}%`}))`
    : Prisma.sql`p."merged_into_id" IS NULL`

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT ${PERSON_SELECT},
           (SELECT COUNT(*) FROM "uin_person_identities" i WHERE i."person_id" = p."id") AS identity_count,
           (SELECT COUNT(*) FROM "uin_threads" t WHERE t."person_id" = p."id") AS thread_count
      FROM "uin_people" p
      LEFT JOIN "uin_organisations" o ON o."id" = p."organisation_id"
     WHERE ${where}
     ORDER BY p."updated_at" DESC
     LIMIT ${opts.perPage} OFFSET ${(opts.page - 1) * opts.perPage}
  `
  const counted = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
      FROM "uin_people" p
      LEFT JOIN "uin_organisations" o ON o."id" = p."organisation_id"
     WHERE ${where}
  `
  return {
    rows: rows.map((r) => ({
      ...mapPerson(r),
      identityCount: Number(r.identity_count ?? 0),
      threadCount: Number(r.thread_count ?? 0),
    })),
    total: Number(counted[0]?.count ?? 0),
  }
}

/** Whoever holds one of these addresses or numbers, by the matching key. A
 *  merged-away person resolves to the person they were merged into. */
export async function findPersonByIdentity(matchValues: string[]): Promise<string | null> {
  if (matchValues.length === 0) return null
  const rows = await prisma.$queryRaw<{ person_id: string; merged_into_id: string | null }[]>`
    SELECT i."person_id", p."merged_into_id"
      FROM "uin_person_identities" i
      JOIN "uin_people" p ON p."id" = i."person_id"
     WHERE i."match_value" IN (${Prisma.join(matchValues)})
     LIMIT 1
  `
  const row = rows[0]
  if (!row) return null
  return row.merged_into_id ?? row.person_id
}

export async function createPerson(data: {
  displayName: string | null
  primaryEmail: string | null
  organisationId: string | null
}): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "uin_people" ("display_name", "primary_email", "organisation_id")
    VALUES (${data.displayName}, ${data.primaryEmail}, ${data.organisationId})
    RETURNING "id"
  `
  return rows[0]!.id
}

export async function updatePerson(id: string, data: {
  displayName?: string | null
  primaryEmail?: string | null
  organisationId?: string | null
  notes?: string | null
}): Promise<void> {
  const sets: Prisma.Sql[] = []
  if (data.displayName !== undefined) sets.push(Prisma.sql`"display_name" = ${data.displayName}`)
  if (data.primaryEmail !== undefined) sets.push(Prisma.sql`"primary_email" = ${data.primaryEmail}`)
  if (data.organisationId !== undefined) sets.push(Prisma.sql`"organisation_id" = ${data.organisationId}`)
  if (data.notes !== undefined) sets.push(Prisma.sql`"notes" = ${data.notes}`)
  if (sets.length === 0) return
  await prisma.$executeRaw`
    UPDATE "uin_people" SET ${Prisma.join(sets, ', ')}, "updated_at" = now() WHERE "id" = ${id}
  `
}

/**
 * Attach a way of reaching somebody.
 *
 * `value` is unique across the whole table, so an address already known to
 * another person is left exactly where it is - two people claiming one mailbox
 * is a merge somebody has to decide on, not something to settle by overwriting.
 */
export async function addIdentity(data: {
  personId: string
  kind: IdentityKind
  value: string
  matchValue: string
  source: string | null
}): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "uin_person_identities" ("person_id", "kind", "value", "match_value", "source")
    VALUES (${data.personId}, ${data.kind}, ${data.value}, ${data.matchValue}, ${data.source})
    ON CONFLICT ("value") DO NOTHING
  `
}

function mapIdentity(r: Record<string, unknown>): PersonIdentity {
  return {
    id: r.id as string,
    personId: r.person_id as string,
    kind: r.kind as IdentityKind,
    value: r.value as string,
    matchValue: (r.match_value as string | null) ?? null,
    source: (r.source as string | null) ?? null,
    createdAt: r.created_at as Date,
  }
}

export async function listIdentities(personId: string): Promise<PersonIdentity[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_person_identities" WHERE "person_id" = ${personId}
     ORDER BY "kind" ASC, "value" ASC
  `
  return rows.map(mapIdentity)
}

export async function deleteIdentity(id: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "uin_person_identities" WHERE "id" = ${id}`
}

// ---------------------------------------------------------------------------
// Organisations. One per mail domain, and only for domains that mean something:
// a free provider is somebody's mailbox host, not a company.
// ---------------------------------------------------------------------------

export async function findOrCreateOrganisation(domain: string, name: string): Promise<string> {
  const existing = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "uin_organisations" WHERE "domain" = ${domain} LIMIT 1
  `
  if (existing[0]) return existing[0].id
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "uin_organisations" ("name", "domain") VALUES (${name}, ${domain})
    ON CONFLICT ("domain") DO UPDATE SET "updated_at" = now()
    RETURNING "id"
  `
  return rows[0]!.id
}

export async function getOrganisation(id: string): Promise<Organisation | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_organisations" WHERE "id" = ${id}
  `
  const r = rows[0]
  if (!r) return null
  return {
    id: r.id as string,
    name: r.name as string,
    domain: (r.domain as string | null) ?? null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  }
}

/** Everybody at one organisation, for the person page's "who else writes to us
 *  from here" line. Merged-away people are not listed. */
export async function peopleInOrganisation(organisationId: string, exceptPersonId: string): Promise<Person[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT ${PERSON_SELECT}
      FROM "uin_people" p
      LEFT JOIN "uin_organisations" o ON o."id" = p."organisation_id"
     WHERE p."organisation_id" = ${organisationId}
       AND p."id" <> ${exceptPersonId}
       AND p."merged_into_id" IS NULL
     ORDER BY p."display_name" ASC NULLS LAST
     LIMIT 12
  `
  return rows.map(mapPerson)
}

// ---------------------------------------------------------------------------
// Attaching a conversation to a person.
// ---------------------------------------------------------------------------

export async function setThreadPerson(
  threadId: string,
  personId: string | null,
  organisationId: string | null,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "uin_threads"
       SET "person_id" = ${personId}, "organisation_id" = ${organisationId}, "updated_at" = now()
     WHERE "id" = ${threadId}
  `
}

/** Conversations nobody has been resolved for yet, newest first.
 *
 *  Newest first on purpose: mail that arrived while the module had no people
 *  layer is what somebody is looking at today, and the archive can catch up
 *  over the following ticks. */
export async function unresolvedThreads(limit: number): Promise<Array<{ id: string }>> {
  return prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "uin_threads"
     WHERE "person_id" IS NULL AND "provider_module" IS NULL
     ORDER BY "last_message_at" DESC NULLS LAST
     LIMIT ${limit}
  `
}

/** The newest inbound message on a conversation, which is what decides whose
 *  conversation it is. Falls back to the newest of anything when we have only
 *  ever written to them. */
export async function counterpartyMessage(threadId: string): Promise<{
  fromName: string | null
  fromAddress: string | null
  toAddresses: string[]
  subject: string | null
  bodyText: string | null
  autoKind: string | null
  direction: string
} | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "from_name", "from_address", "to_addresses", "subject", "body_text", "auto_kind", "direction"
      FROM "uin_messages"
     WHERE "thread_id" = ${threadId} AND "direction" <> 'note'
     ORDER BY ("direction" = 'in') DESC, "sent_at" DESC
     LIMIT 1
  `
  const r = rows[0]
  if (!r) return null
  return {
    fromName: (r.from_name as string | null) ?? null,
    fromAddress: (r.from_address as string | null) ?? null,
    toAddresses: (r.to_addresses as string[] | null) ?? [],
    subject: (r.subject as string | null) ?? null,
    bodyText: (r.body_text as string | null) ?? null,
    autoKind: (r.auto_kind as string | null) ?? null,
    direction: r.direction as string,
  }
}

// ---------------------------------------------------------------------------
// A person's own conversations, and their timeline.
// ---------------------------------------------------------------------------

/**
 * Every conversation this person has had that this viewer may read.
 *
 * The same visibility clause the list and the search box use, for the same
 * reason: a person's page asks the same question in a different shape, and it
 * must not come back with a different answer. Somebody who cannot open
 * accounts@ does not learn what is in it by opening the person who wrote there.
 */
export async function threadsForPerson(
  personId: string,
  inboxIds: string[],
  includeUnrouted: boolean,
  providerModules: string[] = [],
): Promise<ThreadListRow[]> {
  const visible = visibilityClause(inboxIds, includeUnrouted, providerModules)
  if (!visible) return []
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>(
    threadListQuery([visible, Prisma.sql`t."person_id" = ${personId}`], 50, 0),
  )
  return rows.map(mapThreadListRow)
}

export type OutboundLogRow = {
  id: string
  toAddress: string
  subject: string
  templateKey: string | null
  moduleName: string | null
  status: string
  error: string | null
  sentAt: Date
}

/**
 * Automated mail this site has sent them (D13).
 *
 * Order confirmations, purchase order emails, quote emails: all of it goes out
 * through the site's sending account and never touches the owner's own Sent
 * folder, so no amount of reading a mailbox will ever find it. Core's outbound
 * ledger is the only record there is, which is exactly why it exists.
 *
 * A delivery ledger and not an archive - there are no bodies here and there
 * never will be, so the timeline shows that it went and what it was, and that
 * is all it can honestly show.
 */
export async function outboundLogForAddresses(addresses: string[]): Promise<OutboundLogRow[]> {
  if (addresses.length === 0) return []
  const rows = await prisma.emailLog.findMany({
    where: { toAddress: { in: addresses, mode: 'insensitive' } },
    select: {
      id: true, toAddress: true, subject: true, templateKey: true,
      moduleName: true, status: true, error: true, sentAt: true,
    },
    orderBy: { sentAt: 'desc' },
    take: 25,
  })
  return rows
}

// ---------------------------------------------------------------------------
// Links to the site's own records.
// ---------------------------------------------------------------------------

function mapLink(r: Record<string, unknown>): RecordLink {
  return {
    id: r.id as string,
    threadId: (r.thread_id as string | null) ?? null,
    personId: (r.person_id as string | null) ?? null,
    moduleName: r.module_name as string,
    recordType: r.record_type as string,
    recordId: r.record_id as string,
    label: (r.label as string | null) ?? null,
    confidence: Number(r.confidence ?? 100),
    linkedBy: (r.linked_by as 'auto' | 'user') ?? 'auto',
    createdAt: r.created_at as Date,
  }
}

export async function linksForThread(threadId: string): Promise<RecordLink[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_record_links" WHERE "thread_id" = ${threadId}
     ORDER BY "linked_by" DESC, "created_at" ASC
  `
  return rows.map(mapLink)
}

export async function linksForPerson(personId: string): Promise<RecordLink[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_record_links" WHERE "person_id" = ${personId} AND "thread_id" IS NULL
     ORDER BY "linked_by" DESC, "created_at" ASC
  `
  return rows.map(mapLink)
}

export async function getLink(id: string): Promise<RecordLink | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_record_links" WHERE "id" = ${id}
  `
  return rows[0] ? mapLink(rows[0]) : null
}

export async function deleteLink(id: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "uin_record_links" WHERE "id" = ${id}`
}

/** Does this conversation already have that record on it? Asked before the
 *  linker spends a lookup, and again by the unique index behind it. */
export async function threadHasLink(
  threadId: string,
  moduleName: string,
  recordType: string,
  recordId: string,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ one: number }[]>`
    SELECT 1 AS one FROM "uin_record_links"
     WHERE "thread_id" = ${threadId} AND "module_name" = ${moduleName}
       AND "record_type" = ${recordType} AND "record_id" = ${recordId}
     LIMIT 1
  `
  return rows.length > 0
}

// ---------------------------------------------------------------------------
// Merging, splitting, and the audit that makes both survivable.
// ---------------------------------------------------------------------------

export type PersonEventRow = {
  id: string
  userId: string | null
  kind: string
  detail: Record<string, unknown> | null
  createdAt: Date
}

/** An audit row against a person rather than a conversation. Same table, and
 *  the same reason for existing: "who did this and when" is asked afterwards. */
export async function recordPersonEvent(
  personId: string,
  userId: string | null,
  kind: ThreadEventKind,
  detail: Record<string, unknown> | null = null,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "uin_events" ("thread_id", "person_id", "user_id", "kind", "detail")
    VALUES (NULL, ${personId}, ${userId}, ${kind}, ${detail === null ? Prisma.DbNull : detail}::jsonb)
  `
}

export async function listPersonEvents(personId: string): Promise<PersonEventRow[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "id", "user_id", "kind", "detail", "created_at"
      FROM "uin_events" WHERE "person_id" = ${personId}
     ORDER BY "created_at" DESC LIMIT 50
  `
  return rows.map((r) => ({
    id: r.id as string,
    userId: (r.user_id as string | null) ?? null,
    kind: r.kind as string,
    detail: (r.detail as Record<string, unknown> | null) ?? null,
    createdAt: r.created_at as Date,
  }))
}

export type MergeRow = {
  id: string
  winnerId: string
  loserId: string
  userId: string | null
  loserName: string | null
  undoneAt: Date | null
  createdAt: Date
}

/**
 * Fold one person into another.
 *
 * Everything happens in one transaction, and the losing row is kept rather than
 * deleted: `merged_into_id` hides them from every list and redirects anybody
 * holding an old link, and the snapshot records exactly which identities,
 * conversations and links moved so that undoing it puts each one back where it
 * came from. A merge nobody can take back is the one operation in this module
 * that could genuinely lose somebody's history.
 */
export async function mergePeople(
  winnerId: string,
  loserId: string,
  userId: string | null,
): Promise<{ mergeId: string } | { error: string }> {
  if (winnerId === loserId) return { error: 'Those are the same person.' }

  const [winner, loser] = await Promise.all([getPerson(winnerId), getPerson(loserId)])
  if (!winner || !loser) return { error: 'One of those people is no longer here.' }
  if (loser.mergedIntoId) return { error: 'That person has already been merged into somebody else.' }
  if (winner.mergedIntoId) return { error: 'You cannot merge into somebody who has themselves been merged.' }

  return prisma.$transaction(async (tx) => {
    const identities = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "uin_person_identities" WHERE "person_id" = ${loserId}
    `
    const threads = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "uin_threads" WHERE "person_id" = ${loserId}
    `
    const links = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "uin_record_links" WHERE "person_id" = ${loserId}
    `

    const snapshot = {
      loser: {
        displayName: loser.displayName,
        primaryEmail: loser.primaryEmail,
        organisationId: loser.organisationId,
        notes: loser.notes,
      },
      identityIds: identities.map((r) => r.id),
      threadIds: threads.map((r) => r.id),
      linkIds: links.map((r) => r.id),
    }

    await tx.$executeRaw`
      UPDATE "uin_person_identities" SET "person_id" = ${winnerId} WHERE "person_id" = ${loserId}
    `
    await tx.$executeRaw`
      UPDATE "uin_threads" SET "person_id" = ${winnerId}, "updated_at" = now() WHERE "person_id" = ${loserId}
    `
    // A link the winner already holds would collide with the unique index, and
    // a merge that fails because both people had the same order attached is a
    // merge nobody can complete. The duplicate simply goes.
    await tx.$executeRaw`
      DELETE FROM "uin_record_links" l
       WHERE l."person_id" = ${loserId}
         AND EXISTS (
           SELECT 1 FROM "uin_record_links" w
            WHERE w."person_id" = ${winnerId} AND w."thread_id" IS NULL AND l."thread_id" IS NULL
              AND w."module_name" = l."module_name" AND w."record_type" = l."record_type"
              AND w."record_id" = l."record_id")
    `
    await tx.$executeRaw`
      UPDATE "uin_record_links" SET "person_id" = ${winnerId} WHERE "person_id" = ${loserId}
    `
    await tx.$executeRaw`
      UPDATE "uin_people"
         SET "merged_into_id" = ${winnerId}, "updated_at" = now()
       WHERE "id" = ${loserId}
    `
    // The winner keeps whatever they already had and gains only what was blank.
    await tx.$executeRaw`
      UPDATE "uin_people"
         SET "display_name" = COALESCE("display_name", ${loser.displayName}),
             "primary_email" = COALESCE("primary_email", ${loser.primaryEmail}),
             "organisation_id" = COALESCE("organisation_id", ${loser.organisationId}),
             "updated_at" = now()
       WHERE "id" = ${winnerId}
    `

    const merge = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "uin_person_merges" ("winner_id", "loser_id", "user_id", "snapshot")
      VALUES (${winnerId}, ${loserId}, ${userId}, ${JSON.stringify(snapshot)}::jsonb)
      RETURNING "id"
    `
    const mergeId = merge[0]!.id

    await tx.$executeRaw`
      INSERT INTO "uin_events" ("thread_id", "person_id", "user_id", "kind", "detail")
      VALUES (NULL, ${winnerId}, ${userId}, 'merged',
              ${JSON.stringify({ mergeId, loserId, loserName: loser.displayName ?? loser.primaryEmail })}::jsonb)
    `

    return { mergeId }
  })
}

/**
 * Put a merge back.
 *
 * Only what the merge itself moved goes back, by id. Anything that arrived
 * afterwards stays with the person it arrived on, because it was never the
 * loser's - and quietly handing it over would be a second mistake dressed up as
 * fixing the first.
 */
export async function undoMerge(mergeId: string, userId: string | null): Promise<{ ok: true; personId: string } | { error: string }> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_person_merges" WHERE "id" = ${mergeId}
  `
  const row = rows[0]
  if (!row) return { error: 'That merge is not on record.' }
  if (row.undone_at) return { error: 'That merge has already been undone.' }

  const loserId = row.loser_id as string
  const winnerId = row.winner_id as string
  const snapshot = (row.snapshot ?? {}) as {
    identityIds?: string[]
    threadIds?: string[]
    linkIds?: string[]
  }
  const identityIds = snapshot.identityIds ?? []
  const threadIds = snapshot.threadIds ?? []
  const linkIds = snapshot.linkIds ?? []

  await prisma.$transaction(async (tx) => {
    if (identityIds.length > 0) {
      await tx.$executeRaw`
        UPDATE "uin_person_identities" SET "person_id" = ${loserId}
         WHERE "id" IN (${Prisma.join(identityIds)}) AND "person_id" = ${winnerId}
      `
    }
    if (threadIds.length > 0) {
      await tx.$executeRaw`
        UPDATE "uin_threads" SET "person_id" = ${loserId}, "updated_at" = now()
         WHERE "id" IN (${Prisma.join(threadIds)}) AND "person_id" = ${winnerId}
      `
    }
    if (linkIds.length > 0) {
      await tx.$executeRaw`
        UPDATE "uin_record_links" SET "person_id" = ${loserId}
         WHERE "id" IN (${Prisma.join(linkIds)}) AND "person_id" = ${winnerId}
      `
    }
    await tx.$executeRaw`
      UPDATE "uin_people" SET "merged_into_id" = NULL, "updated_at" = now() WHERE "id" = ${loserId}
    `
    await tx.$executeRaw`
      UPDATE "uin_person_merges" SET "undone_at" = now(), "undone_by" = ${userId} WHERE "id" = ${mergeId}
    `
    await tx.$executeRaw`
      INSERT INTO "uin_events" ("thread_id", "person_id", "user_id", "kind", "detail")
      VALUES (NULL, ${winnerId}, ${userId}, 'merged',
              ${JSON.stringify({ mergeId, undone: true, loserId })}::jsonb)
    `
  })

  return { ok: true, personId: loserId }
}

/** Merges involving this person that could still be taken back. */
export async function undoableMerges(personId: string): Promise<MergeRow[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT m."id", m."winner_id", m."loser_id", m."user_id", m."undone_at", m."created_at",
           p."display_name" AS loser_name
      FROM "uin_person_merges" m
      LEFT JOIN "uin_people" p ON p."id" = m."loser_id"
     WHERE m."winner_id" = ${personId} AND m."undone_at" IS NULL
     ORDER BY m."created_at" DESC
     LIMIT 10
  `
  return rows.map((r) => ({
    id: r.id as string,
    winnerId: r.winner_id as string,
    loserId: r.loser_id as string,
    userId: (r.user_id as string | null) ?? null,
    loserName: (r.loser_name as string | null) ?? null,
    undoneAt: (r.undone_at as Date | null) ?? null,
    createdAt: r.created_at as Date,
  }))
}

/**
 * Take some identities off a person and give them to a new one.
 *
 * The other half of a mis-merge, and the answer when a role address turns out
 * to have been two people all along. Conversations follow their address: a
 * conversation whose newest counterparty address moved goes with it, which is
 * what somebody splitting two people apart means by splitting them apart.
 */
export async function splitPerson(
  personId: string,
  identityIds: string[],
  userId: string | null,
): Promise<{ ok: true; personId: string } | { error: string }> {
  if (identityIds.length === 0) return { error: 'Pick at least one address to move.' }

  const owned = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_person_identities"
     WHERE "person_id" = ${personId} AND "id" IN (${Prisma.join(identityIds)})
  `
  if (owned.length === 0) return { error: 'None of those addresses belong to this person.' }

  const remaining = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "uin_person_identities" WHERE "person_id" = ${personId}
  `
  if (Number(remaining[0]?.count ?? 0) <= owned.length) {
    return { error: 'That would move every address, which leaves nobody behind. Rename them instead.' }
  }

  const moved = owned.map(mapIdentity)
  const first = moved[0]!

  const newId = await prisma.$transaction(async (tx) => {
    // Created inside the transaction, not before it: a split that falls over
    // half way through must not leave a person behind with nobody attached.
    const created = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "uin_people" ("display_name", "primary_email")
      VALUES (NULL, ${first.kind === 'email' ? first.value : null})
      RETURNING "id"
    `
    const newId = created[0]!.id
    await tx.$executeRaw`
      UPDATE "uin_person_identities" SET "person_id" = ${newId}
       WHERE "id" IN (${Prisma.join(moved.map((m) => m.id))})
    `
    // Conversations follow the address they were had with.
    // The address as it was stored on the message, not the plus-stripped
    // matching key: from_address holds what the sender actually wrote.
    const movedAddresses = moved.map((m) => m.value.toLowerCase())
    await tx.$executeRaw`
      UPDATE "uin_threads" t
         SET "person_id" = ${newId}, "updated_at" = now()
       WHERE t."person_id" = ${personId}
         AND EXISTS (
           SELECT 1 FROM "uin_messages" m
            WHERE m."thread_id" = t."id"
              AND lower(m."from_address") IN (${Prisma.join(movedAddresses)}))
    `
    await tx.$executeRaw`
      INSERT INTO "uin_events" ("thread_id", "person_id", "user_id", "kind", "detail")
      VALUES (NULL, ${personId}, ${userId}, 'merged',
              ${JSON.stringify({ split: true, toPersonId: newId, identityIds: moved.map((m) => m.id) })}::jsonb)
    `
    return newId
  })

  return { ok: true, personId: newId }
}

/**
 * Conversations the linker should look at: never looked at, or looked at before
 * the newest thing on them arrived.
 *
 * The second half is what catches a reference that turns up in the third reply
 * rather than the first, without re-reading every conversation on the site
 * every hour.
 */
export async function threadsNeedingLinks(limit: number): Promise<Array<{ id: string }>> {
  return prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "uin_threads"
     WHERE "linked_at" IS NULL
        OR ("last_message_at" IS NOT NULL AND "linked_at" < "last_message_at")
     ORDER BY "last_message_at" DESC NULLS LAST
     LIMIT ${limit}
  `
}

export async function markThreadLinked(threadId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "uin_threads" SET "linked_at" = now() WHERE "id" = ${threadId}
  `
}

/** How many people the hub has worked out, and how many of them belong to an
 *  organisation. Shown in settings so the exclusion rules can be sanity
 *  checked rather than taken on trust. */
export async function peopleCount(): Promise<{ people: number; organisations: number }> {
  const rows = await prisma.$queryRaw<{ people: bigint; organisations: bigint }[]>`
    SELECT (SELECT COUNT(*) FROM "uin_people" WHERE "merged_into_id" IS NULL)::bigint AS people,
           (SELECT COUNT(*) FROM "uin_organisations")::bigint AS organisations
  `
  return {
    people: Number(rows[0]?.people ?? 0),
    organisations: Number(rows[0]?.organisations ?? 0),
  }
}

// ---------------------------------------------------------------------------
// Conversations that belong to another module (S7)
//
// A chat, an enquiry, a call and a text land in the same two tables an email
// does, marked with the module that owns them and that module's own id for the
// conversation. Two rules run through everything below:
//
//   The owning module remains the source of truth. Nothing here writes back to
//   it, and what is stored is a copy kept so the hub can list, search and file
//   these conversations beside the email ones.
//
//   A module that goes away leaves its conversations behind. Rows with a
//   provider nobody serves stay readable and searchable rather than
//   disappearing or throwing (E20), which is why none of these columns is a
//   foreign key to anything.
// ---------------------------------------------------------------------------

export type ProviderThreadInput = {
  providerModule: string
  externalId: string
  channel: string
  subject: string | null
  subjectNormalised: string
  preview: string | null
  lastMessageAt: Date
  lastDirection: 'in' | 'out' | 'note'
  unread: boolean
}

/**
 * The conversation as the provider currently describes it.
 *
 * One statement, so two ticks racing land on the unique index rather than on
 * each other. `status` and everything a colleague has done to it here -
 * assignee, snooze, who it belongs to - are deliberately NOT touched on the
 * way through: those are this hub's own bookkeeping, and a refresh from the
 * far end must not undo somebody's morning.
 */
export async function upsertProviderThread(data: ProviderThreadInput): Promise<{
  id: string
  created: boolean
}> {
  const rows = await prisma.$queryRaw<{ id: string; created: boolean }[]>`
    INSERT INTO "uin_threads"
      ("provider_module", "external_id", "channel", "subject", "subject_normalised",
       "preview", "last_message_at", "last_direction", "unread", "message_count")
    VALUES (${data.providerModule}, ${data.externalId}, ${data.channel}, ${data.subject},
            ${data.subjectNormalised}, ${data.preview}, ${data.lastMessageAt},
            ${data.lastDirection}, ${data.unread}, 0)
    ON CONFLICT ("provider_module", "external_id")
      WHERE "provider_module" IS NOT NULL AND "external_id" IS NOT NULL
      DO UPDATE SET
        "subject"            = EXCLUDED."subject",
        "subject_normalised" = EXCLUDED."subject_normalised",
        "preview"            = EXCLUDED."preview",
        "last_message_at"    = GREATEST(
                                 COALESCE("uin_threads"."last_message_at", EXCLUDED."last_message_at"),
                                 EXCLUDED."last_message_at"),
        "last_direction"     = EXCLUDED."last_direction",
        -- Unread only ever goes ON from out here. A conversation somebody has
        -- opened in this hub stays read even while the far end still counts it
        -- as new, because the person who read it is the one sitting here.
        "unread"             = "uin_threads"."unread" OR EXCLUDED."unread",
        "updated_at"         = CURRENT_TIMESTAMP
    RETURNING "id", (xmax = 0) AS "created"
  `
  const row = rows[0]!
  return { id: row.id, created: row.created }
}

export type ProviderMessageInput = {
  threadId: string
  providerModule: string
  providerMessageId: string
  direction: 'in' | 'out' | 'note'
  channel: string
  fromName: string | null
  fromAddress: string | null
  fromPhone: string | null
  subject: string | null
  bodyText: string | null
  bodyHtml: string | null
  snippet: string | null
  sentAt: Date
  attachments?: Array<{
    filename: string
    url: string
    contentType: string | null
  }>
}

/** Files one of the provider's messages. Returns null when we already hold it,
 *  which is the ordinary answer every time a conversation is re-read. */
export async function insertProviderMessage(data: ProviderMessageInput): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "uin_messages"
      ("thread_id", "direction", "channel", "from_name", "from_address", "from_phone",
       "subject", "body_text", "body_html", "snippet", "sent_at", "source",
       "provider_module", "provider_message_id")
    VALUES (${data.threadId}, ${data.direction}, ${data.channel}, ${data.fromName},
            ${data.fromAddress}, ${data.fromPhone}, ${data.subject}, ${data.bodyText},
            ${data.bodyHtml}, ${data.snippet}, ${data.sentAt}, 'provider',
            ${data.providerModule}, ${data.providerMessageId})
    ON CONFLICT ("thread_id", "provider_message_id")
      WHERE "source" = 'provider' AND "provider_message_id" IS NOT NULL
      DO NOTHING
    RETURNING "id"
  `
  const messageId = rows[0]?.id
  if (!messageId) return null
  
  // Insert attachments if provided
  if (data.attachments && data.attachments.length > 0) {
    for (const att of data.attachments) {
      await prisma.$executeRaw`
        INSERT INTO "uin_attachments"
          ("message_id", "filename", "content_type", "external_url")
        VALUES (${messageId}, ${att.filename}, ${att.contentType}, ${att.url})
        ON CONFLICT DO NOTHING
      `
    }
  }
  
  return messageId
}

/** Rolls a provider conversation's counters forward after messages land. */
export async function recountProviderThread(threadId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "uin_threads" t
       SET "message_count" = (SELECT COUNT(*) FROM "uin_messages" m WHERE m."thread_id" = t."id"),
           "updated_at" = CURRENT_TIMESTAMP
     WHERE t."id" = ${threadId}
  `
}

/** The newest thing we hold from each provider, which is what the tick asks it
 *  about. One query for every channel on the site rather than one each. */
export async function providerWatermarks(): Promise<Record<string, Date>> {
  const rows = await prisma.$queryRaw<{ provider_module: string; newest: Date | null }[]>`
    SELECT "provider_module", MAX("last_message_at") AS "newest"
      FROM "uin_threads"
     WHERE "provider_module" IS NOT NULL
     GROUP BY "provider_module"
  `
  const out: Record<string, Date> = {}
  for (const row of rows) if (row.newest) out[row.provider_module] = row.newest
  return out
}

/** What we already hold of one provider conversation, for deciding whether it
 *  is worth opening again. A conversation whose newest message we have got and
 *  whose timestamp has not moved has nothing in it for us. */
export async function providerThreadState(
  providerModule: string,
  externalId: string,
): Promise<{ id: string; lastMessageAt: Date | null; messageCount: number } | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "id", "last_message_at", "message_count"
      FROM "uin_threads"
     WHERE "provider_module" = ${providerModule} AND "external_id" = ${externalId}
     LIMIT 1
  `
  const r = rows[0]
  if (!r) return null
  return {
    id: r.id as string,
    lastMessageAt: (r.last_message_at as Date | null) ?? null,
    messageCount: Number(r.message_count ?? 0),
  }
}

/** The conversations from one provider that have not been given a person yet.
 *  Bounded, like every other pass that rides on the tick. */
export async function providerThreadsNeedingPeople(
  limit: number,
): Promise<Array<{ id: string; providerModule: string }>> {
  const rows = await prisma.$queryRaw<{ id: string; provider_module: string }[]>`
    SELECT "id", "provider_module" FROM "uin_threads"
     WHERE "person_id" IS NULL AND "provider_module" IS NOT NULL
     ORDER BY "last_message_at" DESC NULLS LAST
     LIMIT ${limit}
  `
  return rows.map((r) => ({ id: r.id, providerModule: r.provider_module }))
}

/** The other party on a provider conversation, for working out who they are.
 *  Their address and their number are separate columns for the reason 006
 *  gives: one is an email identity and the other is not. */
export async function providerCounterparty(threadId: string): Promise<{
  name: string | null
  address: string | null
  phone: string | null
} | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "from_name", "from_address", "from_phone"
      FROM "uin_messages"
     WHERE "thread_id" = ${threadId} AND "direction" = 'in'
     ORDER BY "sent_at" DESC
     LIMIT 1
  `
  const r = rows[0]
  if (!r) return null
  return {
    name: (r.from_name as string | null) ?? null,
    address: (r.from_address as string | null) ?? null,
    phone: (r.from_phone as string | null) ?? null,
  }
}

/** The mark put on a reply this hub sent through another module, until that
 *  module hands its own id for it back. */
export const LOCAL_OUTBOUND_PREFIX = 'uin-out:'

/**
 * Match a reply we sent through a provider with that provider's own copy of it.
 *
 * A reply typed here is written down the moment it goes, so the person who sent
 * it sees it rather than waiting an hour for the next collection. The far end
 * then hands the same message back with an id of its own, and without this the
 * conversation would show everything anybody sent twice.
 *
 * Matched on the words and the clock: same conversation, same text, within a
 * few minutes, and only against a row still carrying our own placeholder id.
 * Claiming it rewrites the id in place, so from then on the two are one message
 * by the ordinary unique index.
 */
export async function claimLocalOutbound(input: {
  threadId: string
  bodyText: string
  sentAt: Date
  providerMessageId: string
  windowMs?: number
}): Promise<boolean> {
  const window = input.windowMs ?? 15 * 60_000
  const from = new Date(input.sentAt.getTime() - window)
  const to = new Date(input.sentAt.getTime() + window)
  const updated = await prisma.$executeRaw`
    UPDATE "uin_messages"
       SET "provider_message_id" = ${input.providerMessageId}
     WHERE "id" = (
       SELECT "id" FROM "uin_messages"
        WHERE "thread_id" = ${input.threadId}
          AND "source" = 'provider'
          AND "direction" = 'out'
          AND "provider_message_id" LIKE ${LOCAL_OUTBOUND_PREFIX + '%'}
          AND "body_text" = ${input.bodyText}
          AND "sent_at" BETWEEN ${from} AND ${to}
        ORDER BY "sent_at" ASC
        LIMIT 1
     )
  `
  return updated > 0
}

// ---------------------------------------------------------------------------
// S8: retention, erasure and housekeeping.
//
// Everything below removes things, which makes it the part of this file worth
// reading twice. Three rules hold throughout:
//
//   Nothing is removed without something having asked for it in so many words -
//   a retention window the owner set, or a person somebody chose to erase.
//   Stored attachment objects go before their rows do, so an interrupted sweep
//   leaves an orphaned object rather than a row pointing at nothing.
//   Every count the screens show comes from the same queries the deletes use,
//   so a confirmation dialog cannot promise one thing and do another.
// ---------------------------------------------------------------------------

/** A conversation the retention window has caught up with. */
export type RetentionCandidate = {
  id: string
  lastMessageAt: Date | null
  /** True when it carries a link to one of the site's own records. */
  linked: boolean
}

/** Conversations older than the cutoff, oldest first, in batches. `keepLinked`
 *  is the setting: with it on, a conversation carrying an order, a purchase
 *  order or a quote is left alone however old it is. */
export async function threadsDueForRetention(
  cutoff: Date,
  keepLinked: boolean,
  limit: number,
): Promise<RetentionCandidate[]> {
  const linkCheck = Prisma.sql`EXISTS (
    SELECT 1 FROM "uin_record_links" rl WHERE rl."thread_id" = t."id"
  )`
  const where: Prisma.Sql[] = [Prisma.sql`t."last_message_at" < ${cutoff}`]
  if (keepLinked) where.push(Prisma.sql`NOT ${linkCheck}`)
  // With keepLinked on, every row that survives the WHERE is unlinked by
  // definition, so asking again in the SELECT list is a second pass over the
  // link table for an answer we already have.
  const linked = keepLinked ? Prisma.sql`false` : linkCheck
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT t."id", t."last_message_at", ${linked} AS "linked"
      FROM "uin_threads" t
     WHERE ${Prisma.join(where, ' AND ')}
     ORDER BY t."last_message_at" ASC
     LIMIT ${limit}
  `
  return rows.map((r) => ({
    id: r.id as string,
    lastMessageAt: (r.last_message_at as Date | null) ?? null,
    linked: !!r.linked,
  }))
}

/** What the settings screen shows before anybody turns a window on: how many
 *  conversations the cutoff catches, and how many of those are being kept back
 *  only because they carry a link. Silence about the second number is how
 *  somebody loses the correspondence behind an invoice dispute. */
export async function retentionDueCounts(cutoff: Date): Promise<{ due: number; linked: number }> {
  const rows = await prisma.$queryRaw<{ due: bigint; linked: bigint }[]>`
    SELECT COUNT(*)::bigint AS "due",
           COUNT(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM "uin_record_links" rl WHERE rl."thread_id" = t."id")
           )::bigint AS "linked"
      FROM "uin_threads" t
     WHERE t."last_message_at" < ${cutoff}
  `
  return { due: Number(rows[0]?.due ?? 0), linked: Number(rows[0]?.linked ?? 0) }
}

/** A stored object this module owns, so the sweep can take the bytes out of
 *  storage before it takes the row out of the database. */
export type StoredObjectRef = { attachmentId: string; mediaKey: string; mediaProvider: string }

export async function storedObjectsForThreads(threadIds: string[]): Promise<StoredObjectRef[]> {
  if (threadIds.length === 0) return []
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT a."id", a."media_key", a."media_provider"
      FROM "uin_attachments" a
      JOIN "uin_messages" m ON m."id" = a."message_id"
     WHERE m."thread_id" IN (${Prisma.join(threadIds)})
       AND a."media_key" IS NOT NULL
       AND a."media_provider" IS NOT NULL
  `
  return rows.map((r) => ({
    attachmentId: r.id as string,
    mediaKey: r.media_key as string,
    mediaProvider: r.media_provider as string,
  }))
}

/** Removes the conversations themselves. Messages, attachment rows, events and
 *  links go with them by cascade; the location ledger keeps its row with a null
 *  thread, which is deliberate - it is what stops the next sync collecting the
 *  very mail the owner has just asked us to stop holding. */
export async function deleteThreads(threadIds: string[]): Promise<number> {
  if (threadIds.length === 0) return 0
  return prisma.$executeRaw`
    DELETE FROM "uin_threads" WHERE "id" IN (${Prisma.join(threadIds)})
  `
}

/** People left holding nothing: no conversations, no links, nobody merged into
 *  them, and never edited by hand. E8's other half - a thread that minted a
 *  person and has since gone should not leave the person behind. A name or a
 *  note somebody typed is their work and is never swept. */
export async function pruneOrphanPeople(limit: number): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM "uin_people" p
     WHERE p."id" IN (
       SELECT p2."id" FROM "uin_people" p2
        WHERE p2."display_name" IS NULL
          AND p2."notes" IS NULL
          AND p2."merged_into_id" IS NULL
          AND NOT EXISTS (SELECT 1 FROM "uin_threads" t WHERE t."person_id" = p2."id")
          AND NOT EXISTS (SELECT 1 FROM "uin_record_links" rl WHERE rl."person_id" = p2."id")
          AND NOT EXISTS (SELECT 1 FROM "uin_people" o WHERE o."merged_into_id" = p2."id")
          AND NOT EXISTS (SELECT 1 FROM "uin_person_merges" pm WHERE pm."loser_id" = p2."id" AND pm."undone_at" IS NULL)
        LIMIT ${limit}
     )
  `
}

/** Organisations nobody belongs to any more. They hold a name and a domain and
 *  nothing else, so there is nothing to lose and a settings screen counting
 *  three thousand organisations for eleven people is simply wrong. */
export async function pruneOrphanOrganisations(limit: number): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM "uin_organisations" o
     WHERE o."id" IN (
       SELECT o2."id" FROM "uin_organisations" o2
        WHERE NOT EXISTS (SELECT 1 FROM "uin_people" p WHERE p."organisation_id" = o2."id")
          AND NOT EXISTS (SELECT 1 FROM "uin_threads" t WHERE t."organisation_id" = o2."id")
        LIMIT ${limit}
     )
  `
}

export async function markRetentionRun(): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "uin_settings" SET "retention_last_run_at" = now() WHERE "id" = 'singleton'
  `
}

/**
 * Messages that were written down as 'sending' and never settled. That is a
 * crash between writing the row and the network call answering, and S4 left it
 * for here on purpose: without this they sit in the thread for ever saying
 * "sending", with no way for anybody to tell whether the customer got it.
 *
 * Marked failed rather than removed, because the row is the only evidence the
 * attempt happened at all - and a failed message has a Retry button, which is
 * exactly what somebody wants when they find one.
 */
export async function failStalledSends(olderThan: Date): Promise<number> {
  return prisma.$executeRaw`
    UPDATE "uin_messages"
       SET "delivery_status" = 'failed',
           "delivery_error" = 'This was interrupted while it was being sent, so we cannot tell whether it arrived. Check with them before sending it again.'
     WHERE "delivery_status" = 'sending'
       AND "created_at" < ${olderThan}
  `
}

// ---------------------------------------------------------------------------
// One person: everything held about them, and taking it away again (D17).
// ---------------------------------------------------------------------------

/** What an erase would remove, counted from the same tables the erase deletes
 *  from, so the dialog and the deed cannot disagree. */
export type PersonErasePreview = {
  personId: string
  name: string | null
  conversations: number
  messages: number
  attachments: number
  storedAttachments: number
  identities: string[]
  /** Records elsewhere on the site this person's conversations point at. These
   *  are NOT erased - the link goes, the order does not - and the dialog says
   *  so by name (E22). */
  links: Array<{ moduleName: string; label: string | null }>
  /** Automated mail core's own delivery ledger holds for their addresses. Also
   *  not erased, and also said out loud. */
  outboundLogRows: number
}

export async function personErasePreview(personId: string): Promise<PersonErasePreview | null> {
  const person = await getPerson(personId)
  if (!person) return null

  const identities = await listIdentities(personId)
  const emails = identities.filter((i) => i.kind === 'email').map((i) => i.value.toLowerCase())

  const [counts] = await prisma.$queryRaw<Array<{ conversations: bigint; messages: bigint; attachments: bigint; stored: bigint }>>`
    SELECT COUNT(DISTINCT t."id")::bigint AS "conversations",
           COUNT(DISTINCT m."id")::bigint AS "messages",
           COUNT(DISTINCT a."id")::bigint AS "attachments",
           COUNT(DISTINCT a."id") FILTER (WHERE a."media_key" IS NOT NULL)::bigint AS "stored"
      FROM "uin_threads" t
      LEFT JOIN "uin_messages" m ON m."thread_id" = t."id"
      LEFT JOIN "uin_attachments" a ON a."message_id" = m."id"
     WHERE t."person_id" = ${personId}
  `

  const links = await prisma.$queryRaw<Array<{ module_name: string; label: string | null }>>`
    SELECT DISTINCT rl."module_name", rl."label"
      FROM "uin_record_links" rl
      LEFT JOIN "uin_threads" t ON t."id" = rl."thread_id"
     WHERE rl."person_id" = ${personId} OR t."person_id" = ${personId}
     ORDER BY rl."module_name"
  `

  const outboundLogRows = emails.length > 0
    ? await prisma.emailLog.count({ where: { toAddress: { in: emails, mode: 'insensitive' } } })
    : 0

  return {
    personId,
    name: person.displayName || person.primaryEmail,
    conversations: Number(counts?.conversations ?? 0),
    messages: Number(counts?.messages ?? 0),
    attachments: Number(counts?.attachments ?? 0),
    storedAttachments: Number(counts?.stored ?? 0),
    identities: identities.map((i) => i.value),
    links: links.map((l) => ({ moduleName: l.module_name, label: l.label })),
    outboundLogRows,
  }
}

/** Their conversations, for the erase to walk and for the export to read. */
export async function threadIdsForPerson(personId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "uin_threads" WHERE "person_id" = ${personId}
  `
  return rows.map((r) => r.id)
}

/** Removes the person themselves once their conversations have gone. Identities,
 *  their links and their audit rows go by cascade; the merge ledger does not
 *  (it holds no foreign key on purpose, so a merge survives an undo losing its
 *  row), so it is cleared by hand. */
export async function deletePersonRow(personId: string): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "uin_person_merges" WHERE "winner_id" = ${personId} OR "loser_id" = ${personId}
  `
  await prisma.$executeRaw`DELETE FROM "uin_people" WHERE "id" = ${personId}`
}

/** Every message on a person's conversations, bodies and all, for the export.
 *  This is the one place in the module that hands whole message bodies to a
 *  caller, which is why it exists in its own function with its own name. */
export type ExportMessageRow = {
  id: string
  threadId: string
  direction: string
  channel: string
  subject: string | null
  fromName: string | null
  fromAddress: string | null
  fromPhone: string | null
  toAddresses: string[]
  ccAddresses: string[]
  sentAt: Date | null
  bodyText: string | null
  bodyHtml: string | null
  attachments: Array<{ filename: string; contentType: string | null; sizeBytes: number | null }>
}

export async function exportMessagesForThreads(threadIds: string[]): Promise<ExportMessageRow[]> {
  if (threadIds.length === 0) return []
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT m."id", m."thread_id", m."direction", m."channel", m."subject",
           m."from_name", m."from_address", m."from_phone", m."to_addresses",
           m."cc_addresses", m."sent_at", m."body_text", m."body_html",
           COALESCE(
             (SELECT json_agg(json_build_object(
                'filename', a."filename",
                'contentType', a."content_type",
                'sizeBytes', a."size_bytes"
              ) ORDER BY a."created_at")
                FROM "uin_attachments" a WHERE a."message_id" = m."id"),
             '[]'::json
           ) AS "attachments"
      FROM "uin_messages" m
     WHERE m."thread_id" IN (${Prisma.join(threadIds)})
     ORDER BY m."sent_at" ASC NULLS LAST, m."created_at" ASC
  `
  return rows.map((r) => ({
    id: r.id as string,
    threadId: r.thread_id as string,
    direction: r.direction as string,
    channel: r.channel as string,
    subject: (r.subject as string | null) ?? null,
    fromName: (r.from_name as string | null) ?? null,
    fromAddress: (r.from_address as string | null) ?? null,
    fromPhone: (r.from_phone as string | null) ?? null,
    toAddresses: (r.to_addresses as string[] | null) ?? [],
    ccAddresses: (r.cc_addresses as string[] | null) ?? [],
    sentAt: (r.sent_at as Date | null) ?? null,
    bodyText: (r.body_text as string | null) ?? null,
    bodyHtml: (r.body_html as string | null) ?? null,
    attachments: (r.attachments as ExportMessageRow['attachments'] | null) ?? [],
  }))
}

/** The conversations themselves, without the access filter: the export and the
 *  erase are both administrator-only operations about one named person, and an
 *  export of "everything we hold about you" that quietly left out the inboxes
 *  the administrator happens not to be on would be a false answer to a legal
 *  question. The permission check is in the route. */
export async function exportThreadsForPerson(personId: string): Promise<Array<{
  id: string
  channel: string
  providerModule: string | null
  subject: string | null
  status: string
  lastMessageAt: Date | null
  messageCount: number
  inboxName: string | null
}>> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT t."id", t."channel", t."provider_module", t."subject", t."status",
           t."last_message_at", t."message_count", i."name" AS "inbox_name"
      FROM "uin_threads" t
      LEFT JOIN "uin_inboxes" i ON i."id" = t."inbox_id"
     WHERE t."person_id" = ${personId}
     ORDER BY t."last_message_at" ASC NULLS LAST
  `
  return rows.map((r) => ({
    id: r.id as string,
    channel: r.channel as string,
    providerModule: (r.provider_module as string | null) ?? null,
    subject: (r.subject as string | null) ?? null,
    status: r.status as string,
    lastMessageAt: (r.last_message_at as Date | null) ?? null,
    messageCount: Number(r.message_count ?? 0),
    inboxName: (r.inbox_name as string | null) ?? null,
  }))
}

// ---------------------------------------------------------------------------
// Delivery receipts (S11)
//
// What became of a reply after it left, written by two things that both talk to
// the outside world and neither of which is trusted with more than it needs:
// the webhook route the mail service pushes events at, and the sync engine when
// a read receipt arrives back as an email.
//
// Every write here is idempotent. The mail service redelivers anything it did
// not get a prompt answer to, and a redelivered open is not a second open - so
// the occurrence lands on the unique index, changes nothing, and the counters
// only move when a row was genuinely new.
// ---------------------------------------------------------------------------

/** One thing that happened to a sent message. `receipt_unread` is a read
 *  receipt saying the message was deleted without being opened, which is worth
 *  recording and is emphatically not an open. */
export type DeliveryUpdate = {
  kind: 'delivered' | 'opened' | 'proxy_open' | 'bounced' | 'receipt' | 'receipt_unread'
  occurredAt: Date
  detail: string | null
  bounceKind: string | null
  source: 'brevo' | 'receipt'
}

/**
 * Files one delivery event against one of our sent messages.
 *
 * Returns false when there was nothing to file: a message that no longer exists
 * because the retention sweep has been through, one that was never ours, or an
 * occurrence already recorded. None of those is an error - two of them are the
 * system working - so the caller answers the sender cheerfully either way and
 * nothing gets retried for ever.
 */
export async function recordDeliveryEvent(
  messageId: string,
  update: DeliveryUpdate,
): Promise<boolean> {
  const owned = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "uin_messages"
     WHERE "id" = ${messageId} AND "direction" = 'out'
     LIMIT 1
  `
  if (!owned[0]) return false

  const inserted = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "uin_delivery_events" ("message_id", "kind", "source", "detail", "occurred_at")
    VALUES (${messageId}, ${update.kind}, ${update.source}, ${update.detail}, ${update.occurredAt})
    ON CONFLICT ("message_id", "kind", "occurred_at") DO NOTHING
    RETURNING "id"
  `
  // Already had it. The counters must not move, which is the entire reason the
  // insert happens before the update rather than beside it.
  if (!inserted[0]) return false

  await applyDeliveryEvent(messageId, update)
  return true
}

/** The summary columns on the message, brought up to date by one new event. */
async function applyDeliveryEvent(messageId: string, update: DeliveryUpdate): Promise<void> {
  if (update.kind === 'delivered') {
    // A soft bounce or a deferral that was followed by a delivery was the mail
    // service retrying and getting there. Leaving the failure showing would
    // have somebody chasing a message that arrived.
    await prisma.$executeRaw`
      UPDATE "uin_messages"
         SET "delivered_at" = COALESCE("delivered_at", ${update.occurredAt}),
             "bounced_at"    = CASE WHEN "bounce_kind" IN ('soft', 'deferred') THEN NULL ELSE "bounced_at" END,
             "bounce_kind"   = CASE WHEN "bounce_kind" IN ('soft', 'deferred') THEN NULL ELSE "bounce_kind" END,
             "bounce_detail" = CASE WHEN "bounce_kind" IN ('soft', 'deferred') THEN NULL ELSE "bounce_detail" END
       WHERE "id" = ${messageId}
    `
    return
  }

  if (update.kind === 'opened' || update.kind === 'receipt') {
    // A receipt beats a pixel: somebody's mail program was asked and answered.
    const strength = update.kind === 'receipt' ? 'receipt' : 'human'
    await prisma.$executeRaw`
      UPDATE "uin_messages"
         SET "opened_at"    = COALESCE("opened_at", ${update.occurredAt}),
             "last_open_at" = GREATEST(COALESCE("last_open_at", ${update.occurredAt}), ${update.occurredAt}),
             "open_count"   = "open_count" + 1,
             "open_source"  = CASE
                                WHEN "open_source" = 'receipt' THEN "open_source"
                                ELSE ${strength}
                              END,
             "delivered_at" = COALESCE("delivered_at", ${update.occurredAt})
       WHERE "id" = ${messageId}
    `
    return
  }

  if (update.kind === 'proxy_open') {
    // Deliberately does NOT set opened_at or move the counter. A mail app
    // fetched the picture; that is all anybody knows, and the screen says so in
    // those words rather than claiming somebody read it.
    await prisma.$executeRaw`
      UPDATE "uin_messages"
         SET "last_open_at" = GREATEST(COALESCE("last_open_at", ${update.occurredAt}), ${update.occurredAt}),
             "open_source"  = COALESCE("open_source", 'proxy'),
             "delivered_at" = COALESCE("delivered_at", ${update.occurredAt})
       WHERE "id" = ${messageId}
    `
    return
  }

  if (update.kind === 'bounced') {
    await prisma.$executeRaw`
      UPDATE "uin_messages"
         SET "bounced_at"    = ${update.occurredAt},
             "bounce_kind"   = ${update.bounceKind},
             "bounce_detail" = ${update.detail === null ? null : update.detail.slice(0, 2000)}
       WHERE "id" = ${messageId}
    `
    return
  }

  // receipt_unread. The event row is the whole point of it - nothing on the
  // message changes, because nothing about the message did.
}

/** Every event on one sent message, newest first. For the screen that wants to
 *  show the working rather than the conclusion. */
export async function listDeliveryEvents(messageId: string): Promise<
  Array<{ kind: string; source: string; detail: string | null; occurredAt: Date }>
> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "kind", "source", "detail", "occurred_at"
      FROM "uin_delivery_events"
     WHERE "message_id" = ${messageId}
     ORDER BY "occurred_at" DESC
  `
  return rows.map((r) => ({
    kind: r.kind as string,
    source: r.source as string,
    detail: (r.detail as string | null) ?? null,
    occurredAt: r.occurred_at as Date,
  }))
}

/**
 * The token on the end of the webhook address, minted the first time it is
 * wanted and kept afterwards.
 *
 * Kept rather than regenerated because switching tracking off and on again
 * would otherwise leave a webhook registered at the mail service pointing at an
 * address that now rejects everything, and the only symptom would be silence.
 */
export async function ensureBrevoWebhookSecret(): Promise<string> {
  const existing = await getBrevoWebhookSecret()
  if (existing) return existing
  const secret = randomBytes(24).toString('hex')
  await prisma.$executeRaw`
    INSERT INTO "uin_settings" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING
  `
  await prisma.$executeRaw`
    UPDATE "uin_settings"
       SET "brevo_webhook_secret" = ${secret}, "updated_at" = now()
     WHERE "id" = 'singleton' AND "brevo_webhook_secret" IS NULL
  `
  return (await getBrevoWebhookSecret()) ?? secret
}

export async function getBrevoWebhookSecret(): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ brevo_webhook_secret: string | null }[]>`
    SELECT "brevo_webhook_secret" FROM "uin_settings" WHERE "id" = 'singleton'
  `
  return rows[0]?.brevo_webhook_secret ?? null
}

/** Every Brevo key this site sends through: the site's own, plus whatever an
 *  inbox has been given of its own. Decrypted here because registering a
 *  webhook is the one other thing a sending key is for, and thrown away by the
 *  caller as soon as the registration is done. */
export async function brevoSendingKeys(): Promise<Array<{ label: string; apiKey: string }>> {
  const keys: Array<{ label: string; apiKey: string }> = []
  const siteKey = process.env.BREVO_API_KEY
  if (siteKey) keys.push({ label: 'This site', apiKey: siteKey })

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "name", "address", "brevo_api_key_encrypted"
      FROM "uin_inboxes"
     WHERE "brevo_api_key_encrypted" IS NOT NULL AND "send_transport" = 'brevo'
     ORDER BY "sort_order" ASC
  `
  for (const row of rows) {
    const stored = row.brevo_api_key_encrypted as string | null
    if (!stored) continue
    const apiKey = tryDecryptSecret(stored)
    if (!apiKey) continue
    keys.push({ label: (row.name as string) || (row.address as string), apiKey })
  }

  // The same key set up twice - once for the site and once on an inbox - is one
  // account, and registering the same webhook on it twice would deliver every
  // event two or three times.
  const seen = new Set<string>()
  return keys.filter((entry) => {
    if (seen.has(entry.apiKey)) return false
    seen.add(entry.apiKey)
    return true
  })
}
