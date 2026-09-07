import { randomBytes } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { encryptSecret, tryDecryptSecret } from '@/lib/crypto/secrets'
import { normaliseAddress } from './addresses'
import type { ThreadRef } from './threading'
import { mergedStatus, mergedUnread, validateMerge } from './thread-merge'
import type { OutboundCandidate } from './relay-copy'
import { readableHtml } from './html'
import { remoteImageUrls } from './remote-images'
import { DRAFT_MODES, DRAFT_SEND_STATES, isInboxKind, isSignatureKind } from './types'
import type {
  AttachmentFetchMode,
  Connection,
  ContactCategory,
  ContactOrigin,
  DiscoveredFolder,
  Draft,
  DraftAttachment,
  DraftBodyFormat,
  DraftMode,
  DraftProduct,
  DraftSendState,
  IdentityKind,
  Inbox,
  InboxAccess,
  InboxAudience,
  InboxKind,
  UserDefaultInbox,
  Organisation,
  Person,
  PersonIdentity,
  PostalAddress,
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
    kind: isInboxKind(r.kind) ? r.kind : 'shared',
    ownerUserId: (r.owner_user_id as string | null) ?? null,
    connectionId: (r.connection_id as string | null) ?? null,
    imapFolder: (r.imap_folder as string) ?? 'INBOX',
    sentFolder: (r.sent_folder as string | null) ?? null,
    isCatchAll: !!r.is_catch_all,
    folderOwnsMail: !!r.folder_owns_mail,
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

/** The kind and the owner of every address on the site, for resolving one
 *  person's view of the lot in a single query. Deliberately not `listInboxes` -
 *  that reads every signature and every SMTP setting to answer a question about
 *  who may open what. */
export async function listInboxAudiences(): Promise<InboxAudience[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "id", "kind", "owner_user_id" FROM "uin_inboxes"
  `
  return rows.map(mapAudience)
}

/** The same two facts about one address, or null when there is no such address.
 *  A missing row is not "open to everybody" - the caller must treat it as a
 *  refusal, which is what every caller in lib/access.ts does. */
export async function getInboxAudience(id: string): Promise<InboxAudience | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "id", "kind", "owner_user_id" FROM "uin_inboxes" WHERE "id" = ${id}
  `
  return rows[0] ? mapAudience(rows[0]) : null
}

function mapAudience(r: Record<string, unknown>): InboxAudience {
  return {
    id: r.id as string,
    kind: isInboxKind(r.kind) ? r.kind : 'shared',
    ownerUserId: (r.owner_user_id as string | null) ?? null,
  }
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
  kind?: InboxKind
  ownerUserId?: string | null
  connectionId?: string | null
  imapFolder?: string
  sentFolder?: string | null
  isCatchAll?: boolean
  folderOwnsMail?: boolean
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
      ("name", "address", "kind", "owner_user_id",
       "connection_id", "imap_folder", "sent_folder", "is_catch_all",
       "folder_owns_mail",
       "send_transport", "brevo_api_key_encrypted", "smtp_host", "smtp_port", "smtp_username",
       "smtp_password_encrypted", "from_name", "signature_kind", "signature", "signature_html",
       "signature_puck", "append_to_sent", "colour", "sort_order")
    VALUES (${data.name}, ${normaliseAddress(data.address)},
            ${data.kind ?? 'shared'}, ${data.kind === 'individual' ? data.ownerUserId ?? null : null},
            ${data.connectionId ?? null},
            ${data.imapFolder ?? 'INBOX'}, ${data.sentFolder ?? null}, ${data.isCatchAll ?? false},
            ${data.folderOwnsMail ?? false},
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
  // The pair moves together: an address that becomes the team's keeps no owner,
  // and one that becomes somebody's own has no meaning without one. Written
  // here rather than left to the caller because half of this landing is an
  // inbox nobody can read.
  if (data.kind !== undefined) {
    sets.push(Prisma.sql`"kind" = ${data.kind}`)
    if (data.kind === 'shared') sets.push(Prisma.sql`"owner_user_id" = ${null}`)
    else if (data.ownerUserId !== undefined) sets.push(Prisma.sql`"owner_user_id" = ${data.ownerUserId}`)
  } else if (data.ownerUserId !== undefined) {
    sets.push(Prisma.sql`"owner_user_id" = ${data.ownerUserId}`)
  }
  if (data.connectionId !== undefined) sets.push(Prisma.sql`"connection_id" = ${data.connectionId}`)
  if (data.imapFolder !== undefined) sets.push(Prisma.sql`"imap_folder" = ${data.imapFolder}`)
  if (data.sentFolder !== undefined) sets.push(Prisma.sql`"sent_folder" = ${data.sentFolder}`)
  if (data.isCatchAll !== undefined) sets.push(Prisma.sql`"is_catch_all" = ${data.isCatchAll}`)
  if (data.folderOwnsMail !== undefined) sets.push(Prisma.sql`"folder_owns_mail" = ${data.folderOwnsMail}`)
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
 * The order one person keeps the top of their rail in, or an empty list when
 * they have never rearranged it.
 *
 * A preference rather than a setting: it is read on every draw of the hub and
 * written by the person themselves, and nobody else's screen ever shows it.
 * Keys, not positions - see migrations/043_user_rail_order.sql for what they
 * are and why nothing validates them.
 */
export async function railOrderFor(userId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ keys: string[] }[]>`
    SELECT "keys" FROM "uin_user_rail_order" WHERE "user_id" = ${userId} LIMIT 1
  `
  return rows[0]?.keys ?? []
}

/** The whole of that order, replaced. One person's own list, all of which is on
 *  their screen when they drag it, so there is nothing of anybody else's to
 *  merge around - which is the difference between this and the site-wide
 *  orders, where what somebody posts is only ever what they could see. */
export async function setRailOrder(userId: string, keys: string[]): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "uin_user_rail_order" ("user_id", "keys")
    VALUES (${userId}, ${keys}::text[])
    ON CONFLICT ("user_id") DO UPDATE
       SET "keys" = ${keys}::text[], "updated_at" = now()
  `
}

/** Whether this address is somebody's own rather than a department's.
 *
 *  Asked at send time, because it settles whose signature goes at the foot:
 *  a personal address signs as its owner whoever is holding the keyboard. */
export async function inboxIsSomebodysOwn(inboxId: string): Promise<boolean> {
  // Two ways of being somebody's own, and either one settles it. An individual
  // inbox is one by definition; a shared address can still be the one somebody
  // opens on and signs as, which is the older of the two and the reason a site
  // that has set neither behaves exactly as it always did.
  const rows = await prisma.$queryRaw<{ one: number }[]>`
    SELECT 1 AS one FROM "uin_user_default_inbox" WHERE "inbox_id" = ${inboxId}
    UNION ALL
    SELECT 1 AS one FROM "uin_inboxes" WHERE "id" = ${inboxId} AND "kind" = 'individual'
    LIMIT 1
  `
  return rows.length > 0
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
  showAvatars: false,
  autoCheckSeconds: null,
  campaignCooldownDays: 7,
  campaignLogMonths: 24,
  campaignFooterAddress: null,
  hiddenChannelModules: [],
  channelOrder: [],
  autoAssignOwnPost: true,
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
    // Off for a row written before the column existed, which is the same answer
    // a fresh install gets and the only safe one: nobody's customers are opted
    // into being looked up somewhere else by a restore.
    showAvatars: !!r.show_avatars,
    // Off for a row written before the column existed, and off on a fresh
    // install: checking every minute is a decision about somebody's hosting
    // bill, and it is theirs to make rather than ours to assume.
    autoCheckSeconds: r.auto_check_seconds === null || r.auto_check_seconds === undefined
      ? null
      : Number(r.auto_check_seconds),
    // A week for a row written before the column existed, which is the same
    // answer a fresh install gets: a guard that arrives switched off in an
    // update is a guard nobody knows they are missing.
    campaignCooldownDays: r.campaign_cooldown_days === null || r.campaign_cooldown_days === undefined
      ? 7
      : Number(r.campaign_cooldown_days),
    campaignLogMonths: r.campaign_log_months === null || r.campaign_log_months === undefined
      ? 24
      : Number(r.campaign_log_months),
    campaignFooterAddress: (r.campaign_footer_address as string | null) ?? null,
    // Nothing hidden for a row written before the column existed, which is
    // the same answer a fresh install gets: an update that quietly hid a
    // channel would look exactly like one that lost the messages.
    hiddenChannelModules: (r.hidden_channel_modules as string[] | null) ?? [],
    // Empty for a row written before the column existed, which is the same
    // answer a fresh install gets: nothing rearranged, so the channels sit in
    // the order the modules were found in.
    channelOrder: (r.channel_order as string[] | null) ?? [],
    // ON for a row written before the column existed, which is the same answer
    // a fresh install gets - and the deliberate exception to the "a new switch
    // arrives off" rule the two above follow. Those two send something out;
    // this one only decides whose name goes beside a conversation that nobody
    // but its owner can open anyway.
    autoAssignOwnPost: r.auto_assign_own_post === undefined ? true : !!r.auto_assign_own_post,
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
  if (data.showAvatars !== undefined) sets.push(Prisma.sql`"show_avatars" = ${data.showAvatars}`)
  if (data.autoCheckSeconds !== undefined) sets.push(Prisma.sql`"auto_check_seconds" = ${data.autoCheckSeconds}`)
  if (data.campaignCooldownDays !== undefined) sets.push(Prisma.sql`"campaign_cooldown_days" = ${data.campaignCooldownDays}`)
  if (data.campaignLogMonths !== undefined) sets.push(Prisma.sql`"campaign_log_months" = ${data.campaignLogMonths}`)
  if (data.campaignFooterAddress !== undefined) sets.push(Prisma.sql`"campaign_footer_address" = ${data.campaignFooterAddress}`)
  if (data.hiddenChannelModules !== undefined) sets.push(Prisma.sql`"hidden_channel_modules" = ${data.hiddenChannelModules}`)
  if (data.channelOrder !== undefined) sets.push(Prisma.sql`"channel_order" = ${data.channelOrder}::text[]`)
  if (data.autoAssignOwnPost !== undefined) sets.push(Prisma.sql`"auto_assign_own_post" = ${data.autoAssignOwnPost}`)
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
 * The replies this hub sent around a given moment that have never been found in
 * a mailbox, so a delivered copy carrying a relay's own Message-ID can be
 * matched back to one of them (see lib/relay-copy.ts).
 *
 * "Never been found" is `connection_id IS NULL`: the send path leaves it empty
 * and it is filled the moment a copy of that message is met on an account, so a
 * row can only ever be claimed once. The window is applied here and the rest of
 * the test - the recipients, the subject - is applied in memory, because it is
 * a handful of rows and the rules that decide are worth being able to read.
 */
export async function unlocatedOutboundNear(input: {
  fromAddress: string
  sentAt: Date
  windowMs: number
}): Promise<OutboundCandidate[]> {
  const from = new Date(input.sentAt.getTime() - input.windowMs)
  const to = new Date(input.sentAt.getTime() + input.windowMs)
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "id", "thread_id", "message_id_header", "to_addresses", "cc_addresses", "subject", "sent_at"
      FROM "uin_messages"
     WHERE "direction" = 'out'
       AND "channel" = 'email'
       AND "connection_id" IS NULL
       AND lower("from_address") = ${input.fromAddress.toLowerCase()}
       AND "sent_at" BETWEEN ${from} AND ${to}
     ORDER BY "sent_at"
     LIMIT 20
  `
  return rows.map((r) => ({
    id: r.id as string,
    threadId: r.thread_id as string,
    messageIdHeader: (r.message_id_header as string | null) ?? null,
    toAddresses: (r.to_addresses as string[] | null) ?? [],
    ccAddresses: (r.cc_addresses as string[] | null) ?? [],
    subject: (r.subject as string | null) ?? null,
    sentAt: r.sent_at as Date,
  }))
}

/**
 * Records the Message-ID a relay put on our message in place of ours.
 *
 * It is the handle everybody else in the world now knows the message by: it is
 * what the recipient's mail client quotes in In-Reply-To, and threadsForMessageIds
 * matches it, so a reply lands on the conversation it answers instead of
 * starting a new one.
 */
export async function recordRelayIdentity(messageId: string, relayMessageId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "uin_messages"
       SET "provider_message_id" = ${relayMessageId}
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
): Promise<Map<string, ThreadRef[]>> {
  if (messageIds.length === 0) return new Map()
  // A conversation that lost a merge is skipped. Its messages moved to the
  // winner, so the winner is what a reference resolves to - but the duplicate
  // copies a merge deliberately leaves behind (see mergeThreads) still carry
  // the same Message-ID, and following one of those would file the reply onto a
  // conversation no list shows.
  const rows = await prisma.$queryRaw<{
    message_id_header: string
    thread_id: string
    inbox_id: string | null
    absorbed_inbox_ids: string[] | null
  }[]>`
    SELECT m."message_id_header", m."thread_id", t."inbox_id",
           ${ABSORBED_INBOX_IDS} AS absorbed_inbox_ids
      FROM "uin_messages" m
      JOIN "uin_threads" t ON t."id" = m."thread_id"
     WHERE m."message_id_header" = ANY(${messageIds}::text[])
       AND t."merged_into_id" IS NULL
    UNION ALL
    SELECT m."provider_message_id" AS "message_id_header", m."thread_id", t."inbox_id",
           ${ABSORBED_INBOX_IDS} AS absorbed_inbox_ids
      FROM "uin_messages" m
      JOIN "uin_threads" t ON t."id" = m."thread_id"
     WHERE m."provider_message_id" = ANY(${messageIds}::text[])
       AND t."merged_into_id" IS NULL
  `
  // Every thread a referenced id sits on, not just the first. Internal mail is
  // held once per inbox involved, and the caller picks the side it belongs to.
  const map = new Map<string, ThreadRef[]>()
  for (const row of rows) {
    const refs = map.get(row.message_id_header) ?? []
    if (refs.some((ref) => ref.threadId === row.thread_id)) continue
    refs.push({
      threadId: row.thread_id,
      inboxId: row.inbox_id,
      absorbedInboxIds: row.absorbed_inbox_ids ?? [],
    })
    map.set(row.message_id_header, refs)
  }
  return map
}

/** Which threads already hold this message on this account. Empty means it is
 *  new; one entry short of its sides means a side is still to be filed. */
export async function threadsHoldingIdentity(
  connectionId: string,
  messageIdHeader: string,
  internalKey: string | null,
): Promise<Set<string>> {
  const rows = await prisma.$queryRaw<{ thread_id: string }[]>`
    SELECT "thread_id" FROM "uin_messages"
     WHERE "connection_id" = ${connectionId}
       AND ("message_id_header" = ${messageIdHeader}
            OR (${internalKey}::text IS NOT NULL AND "internal_key" = ${internalKey}))
  `
  return new Set(rows.map((r) => r.thread_id))
}

export type ThreadCandidateRow = {
  id: string
  inboxId: string | null
  absorbedInboxIds?: string[]
  subjectNormalised: string | null
  lastMessageAt: Date | null
  participants: string[]
}

/** The addresses a conversation belongs to, as a column. Empty for everything
 *  that has never been merged, which is what `effectiveInboxIds` reads as
 *  "just the one in inbox_id". Written once because three separate queries
 *  need it and a fourth will. */
const ABSORBED_INBOX_IDS = Prisma.sql`
  COALESCE(
    ARRAY(SELECT ti."inbox_id" FROM "uin_thread_inboxes" ti WHERE ti."thread_id" = t."id"),
    ARRAY[]::text[]
  )`

/** Threads that could be the same conversation as a message the headers cannot
 *  place: same normalised subject, recent enough to still be one. */
export async function candidateThreads(
  subjectNormalised: string,
  since: Date
): Promise<ThreadCandidateRow[]> {
  if (!subjectNormalised) return []
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT t."id", t."inbox_id", t."subject_normalised", t."last_message_at",
           ${ABSORBED_INBOX_IDS} AS absorbed_inbox_ids,
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
       AND t."merged_into_id" IS NULL
       AND (t."last_message_at" IS NULL OR t."last_message_at" >= ${since})
     ORDER BY t."last_message_at" DESC NULLS LAST
     LIMIT 25
  `
  return rows.map((r) => ({
    id: r.id as string,
    inboxId: (r.inbox_id as string | null) ?? null,
    absorbedInboxIds: (r.absorbed_inbox_ids as string[] | null) ?? [],
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
  /** Post the site turned away at the door: born in the bin, and born done so
   *  it is not sitting in anybody's Open pile behind the junk clause. Left
   *  UNREAD by the caller, which is what lets the Spam folder say how much has
   *  arrived. See migration 044. */
  blocked?: boolean
}): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "uin_threads"
      ("inbox_id", "channel", "subject", "subject_normalised", "preview",
       "last_message_at", "last_direction", "unread", "message_count",
       "status", "blocked_at")
    VALUES (${data.inboxId}, 'email', ${data.subject}, ${data.subjectNormalised}, ${data.preview},
            ${data.lastMessageAt}, ${data.lastDirection}, ${data.unread}, 0,
            ${data.blocked ? 'done' : 'open'}, ${data.blocked ? new Date() : null})
    RETURNING "id"
  `
  return rows[0]!.id
}

/**
 * The site's own junk stamp, put on or taken off one conversation.
 *
 * ON is the collecting pass, and only ever the collecting pass: a message has
 * arrived from an address the site refuses, so the conversation goes into the
 * bin for everybody, marked done and left unread. `blocked_at` is only ever
 * written once - a nuisance who writes six times has one conversation stamped
 * with the day they first got through, not one that keeps moving.
 *
 * OFF is somebody pressing "Not junk", and it is the only way out. Without it a
 * refused conversation could be taken out of the presser's own bin and stay in
 * the site's, which is a conversation that cannot be rescued from a screen that
 * says it just was. The status goes back to open with it, since the done was
 * the site's housekeeping rather than anybody's decision that the matter was
 * finished. The SENDER stays blocked either way: letting one conversation
 * through is a different decision from opening the front door, and it is a
 * different button in a different place.
 */
export async function setThreadBlocked(threadId: string, blocked: boolean): Promise<void> {
  if (blocked) {
    await prisma.$executeRaw`
      UPDATE "uin_threads"
         SET "blocked_at" = COALESCE("blocked_at", now()),
             "status" = 'done',
             "snooze_until" = NULL,
             "unread" = true,
             "updated_at" = now()
       WHERE "id" = ${threadId}
    `
    return
  }
  await prisma.$executeRaw`
    UPDATE "uin_threads"
       SET "blocked_at" = NULL,
           "status" = 'open',
           "snooze_until" = NULL,
           "updated_at" = now()
     WHERE "id" = ${threadId} AND "blocked_at" IS NOT NULL
  `
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
  /** Set only on mail between two of our own addresses: the handle that spots
   *  the second copy of it when a relay rewrote the Message-ID. */
  internalKey?: string | null
}

/**
 * Files a message. The unique index on (connection_id, thread_id,
 * message_id_header) is the real guard: two ticks racing, or the same mail found
 * in a second folder, both land on ON CONFLICT DO NOTHING and return null rather
 * than a duplicate.
 *
 * The thread is part of that key because one internal email is genuinely two
 * messages - Marcus's sent one and Chris's received one - each on its own
 * conversation. It is NOT a licence to file the same mail twice on one thread:
 * the caller looks up which threads already hold it before writing, and a
 * second copy carrying a rewritten Message-ID is turned away by the separate
 * unique index on (thread_id, internal_key).
 *
 * The conflict clause names no columns on purpose. Given a target, Postgres
 * guards THAT index and raises 23505 for a clash on any other - so naming the
 * Message-ID index turned a duplicate spotted by the pair key into an exception
 * that aborted the whole sweep. Bare DO NOTHING covers every unique index on
 * the table, which is what "we already hold this" has always meant here.
 */
export async function insertMessage(data: InsertMessageInput): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "uin_messages"
      ("thread_id", "connection_id", "direction", "channel", "message_id_header", "in_reply_to",
       "references_header", "from_name", "from_address", "reply_to", "to_addresses", "cc_addresses", "subject",
       "body_text", "body_html", "snippet", "sent_at", "has_attachments", "size_bytes", "source",
       "imap_folder", "imap_uid", "thread_match", "routed_on", "auto_kind", "internal_key")
    VALUES (${data.threadId}, ${data.connectionId}, ${data.direction}, 'email', ${data.messageIdHeader},
            ${data.inReplyTo}, ${data.references}::text[], ${data.fromName}, ${data.fromAddress},
            ${data.replyTo}, ${data.toAddresses}::text[], ${data.ccAddresses}::text[], ${data.subject}, ${data.bodyText},
            ${data.bodyHtml}, ${data.snippet}, ${data.sentAt}, ${data.hasAttachments}, ${data.sizeBytes},
            'imap', ${data.imapFolder}, ${data.imapUid}::bigint, ${data.threadMatch}, ${data.routedOn},
            ${data.autoKind}, ${data.internalKey ?? null})
    ON CONFLICT DO NOTHING
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
  /** This message has just reached the site, rather than being history the
   *  backfill is walking through. Only the forward pass of a sweep sets it, and
   *  it is what lets a back-dated email say so - see last_arrived_at below. */
  arrivedNow: boolean
}): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "uin_threads"
       SET "last_message_at" = GREATEST(COALESCE("last_message_at", ${data.sentAt}), ${data.sentAt}),
           -- When post arrived that the line above cannot show, because the mail
           -- is dated behind what this conversation already holds. Filing an
           -- email into a watched folder by hand does exactly that, and without
           -- this the conversation does not move an inch (migration 045).
           --
           -- Written only in that case, so an ordinary message leaves it null
           -- and the list orders that conversation on its mail date as it always
           -- has. Never on the backfill pass, where every message is behind by
           -- definition and stamping them would float the entire mailbox.
           --
           -- Read against the row as it stands before this UPDATE, which is what
           -- Postgres does with every expression in a SET.
           "last_arrived_at" = CASE
             WHEN ${data.arrivedNow} AND "last_message_at" IS NOT NULL AND "last_message_at" > ${data.sentAt}
             THEN now() ELSE "last_arrived_at" END,
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

/**
 * Hands an inbox the mail already sitting in its folder with nowhere to go.
 *
 * Turning "everything in that folder belongs to this address" on settles how
 * mail is filed FROM NOW ON, and the message that made somebody go looking for
 * the setting is by definition already collected - dragged into the folder
 * yesterday, filed under Not filed, and never read again: a message is parsed
 * once and its location remembered, so no later sweep gets a second opinion on
 * it. Without this, the owner turns the setting on and the email they turned it
 * on for is still missing.
 *
 * Deliberately narrow. Only conversations with NO inbox at all are adopted -
 * anything already filed under an address stays where it is - and only where
 * this connection has a message in this inbox's own folder. `provider_module`
 * conversations (live chat, the contact form) are not email and are left alone.
 *
 * Returns how many conversations moved, which the settings screen says out loud
 * rather than leaving the owner to guess whether anything happened.
 */
export async function adoptUnroutedFolderMail(inboxId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "uin_threads" t
       SET "inbox_id" = i."id",
           "updated_at" = now()
      FROM "uin_inboxes" i
     WHERE i."id" = ${inboxId}
       AND i."connection_id" IS NOT NULL
       AND t."inbox_id" IS NULL
       AND t."provider_module" IS NULL
       AND EXISTS (
             SELECT 1
               FROM "uin_messages" m
              WHERE m."thread_id" = t."id"
                AND m."connection_id" = i."connection_id"
                AND lower(m."imap_folder") = lower(i."imap_folder")
           )
    RETURNING t."id"
  `
  if (rows.length === 0) return 0

  // The record of how each one was filed, brought into line with the answer it
  // would get today. Left as 'none' they would go on counting towards the "post
  // nobody is reading" figure on the settings screen for ever.
  const ids = rows.map((r) => r.id)
  await prisma.$executeRaw`
    UPDATE "uin_messages"
       SET "routed_on" = 'folder'
     WHERE "routed_on" = 'none'
       AND "thread_id" IN (${Prisma.join(ids)})
  `
  return rows.length
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
  /** The blind copies. Stored so the copy filed in the mailbox's own Sent
   *  folder is honest about who actually got it, and so a retry sends the same
   *  message rather than a narrower one. Left out is none, which is what mail a
   *  module sends on its own always has. */
  bccAddresses?: string[]
  subject: string
  bodyText: string
  bodyHtml: string
  snippet: string
  hasAttachments: boolean
  sizeBytes: number | null
  /** Null for a message no person typed - a module's automatic mail, kept in
   *  the inbox it went out from so the reply has something to sit under. */
  authorUserId: string | null
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
  bccAddresses: string[]
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
    bccAddresses: (r.bcc_addresses as string[] | null) ?? [],
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
       "bcc_addresses", "subject", "body_text", "body_html", "snippet", "sent_at",
       "has_attachments", "size_bytes", "source", "delivery_status", "author_user_id",
       "idempotency_key", "thread_match", "routed_on")
    VALUES (${data.threadId}, ${data.inboxId}, 'out', 'email', ${data.messageIdHeader},
            ${data.inReplyTo}, ${data.references}::text[], ${data.fromName}, ${data.fromAddress},
            ${data.toAddresses}::text[], ${data.ccAddresses}::text[],
            ${data.bccAddresses ?? []}::text[], ${data.subject},
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
  /** Every address the conversation belongs to, where a merge has given it more
   *  than one. Empty on everything that has never been merged. Carried on the
   *  row because the guest list reads it (see access.ts): a conversation
   *  fetched without it would be judged on its own inbox alone, which locks the
   *  other side out of something they were merged into. */
  absorbedInboxIds: string[]
  /** Set on the losing side of a merge, pointing at what it became part of. */
  mergedIntoId: string | null
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
    SELECT t."id", t."inbox_id", t."channel", t."provider_module", t."external_id",
           t."subject", t."subject_normalised", t."status", t."merged_into_id",
           ${ABSORBED_INBOX_IDS} AS absorbed_inbox_ids
      FROM "uin_threads" t WHERE t."id" = ${id}
  `
  const r = rows[0]
  if (!r) return null
  return {
    id: r.id as string,
    inboxId: (r.inbox_id as string | null) ?? null,
    absorbedInboxIds: (r.absorbed_inbox_ids as string[] | null) ?? [],
    mergedIntoId: (r.merged_into_id as string | null) ?? null,
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

/**
 * Starts a discussion: a conversation between colleagues with no outside party
 * on it at all (see migrations/029_discussions.sql).
 *
 * It opens UNREAD, which is the one place a discussion differs from the notes
 * it is made of. A note deliberately does not mark a conversation unread -
 * colleagues talking about a customer's email should not look like the customer
 * writing again - but a discussion nobody has been told about is a discussion
 * nobody reads. The person starting it sees their own as unread for a moment,
 * which is the cheaper of the two mistakes, because a conversation carries one
 * unread flag between everybody rather than one each.
 */
export async function createDiscussionThread(data: {
  inboxId: string
  subject: string
  subjectNormalised: string
  preview: string | null
  /** Who started it. Named on the row rather than worked out from the opening
   *  note, because the list asks this question about every conversation it
   *  draws and a discussion's every message is a note - see
   *  migrations/040_discussion_parties.sql. */
  startedByUserId: string
  /** The colleagues it was put to, in the order they were added. */
  toUserIds: string[]
}): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "uin_threads"
      ("inbox_id", "channel", "subject", "subject_normalised", "preview",
       "last_message_at", "last_direction", "unread", "message_count",
       "started_by_user_id", "to_user_ids")
    VALUES (${data.inboxId}, 'discussion', ${data.subject}, ${data.subjectNormalised},
            ${data.preview}, now(), 'note', true, 1,
            ${data.startedByUserId}, ${data.toUserIds}::text[])
    RETURNING "id"
  `
  return rows[0]!.id
}

/**
 * The addresses of the colleagues a discussion was put to.
 *
 * Their OWN address and nothing else: being let in to cover somebody's post is
 * not being written to, and a shared address a colleague happens to be on is
 * the team's rather than theirs. A colleague who has not been given an address
 * of their own comes back with nothing, which is honest - there is nowhere for
 * it to land, and the ask on their own list is how they reach it.
 */
export async function ownInboxIdsForUsers(userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return []
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "uin_inboxes"
     WHERE "kind" = 'individual'
       AND "owner_user_id" IN (${Prisma.join(userIds)})
  `
  return rows.map((r) => r.id)
}

/**
 * File one conversation under several of the site's addresses.
 *
 * The same table a merge writes (migrations/031_thread_merges.sql), and
 * deliberately so: every list, tab, unread tally and guest list in this module
 * already reaches a conversation that belongs to more than one address through
 * it, so a discussion put to three colleagues needs none of them taught a
 * second route. The conversation's OWN address has to be among the ids -
 * `effectiveInboxIds` reads this list INSTEAD of `inbox_id` once it is not
 * empty, so leaving it out would file a discussion out of the address it was
 * started in.
 */
export async function fileThreadInInboxes(threadId: string, inboxIds: string[]): Promise<void> {
  const ids = [...new Set(inboxIds)]
  // One address is what every conversation has, and rows here would say the
  // same thing at the cost of a join - so nothing is written.
  if (ids.length < 2) return
  await prisma.$executeRaw`
    INSERT INTO "uin_thread_inboxes" ("thread_id", "inbox_id")
    SELECT ${threadId}, x FROM unnest(${ids}::text[]) AS x
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
  /** Who is looking. Required rather than optional, so that adding a list to
   *  this module cannot quietly skip the junk clause below: a caller that has
   *  not said who is reading does not compile.
   *
   *  "This is junk" is one person's opinion about one conversation rather than
   *  a fact about it (see lib/spam.ts and migrations/041_spam.sql), so every
   *  list here is a list as ONE named person sees it. */
  viewerUserId: string
  /** The Spam folder: one person's bin, rather than everything that is not in
   *  anybody's. The one filter that turns the clause round instead of dropping
   *  it - there is no view in this module that shows both. */
  spamOnly?: boolean
  /** WHOSE bin, when `spamOnly` is on. Null or absent means the reader's own,
   *  which is what the Spam entry under "Yours" asks for.
   *
   *  A colleague's id is the folder under their name on the rail - the same
   *  shape as their Sent and their Mentioned - and it exists because junk filed
   *  in somebody's own address goes into THEIR bin rather than into the bin of
   *  whoever happened to be covering their post that morning. Without a way to
   *  look at it, a coverer's mis-click would be a message only its owner could
   *  ever get back.
   *
   *  Resolved against the addresses the reader may actually read before it gets
   *  here - never trusted from the address bar (E17). */
  spamOwnerUserId?: string | null
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
  /** Widen ONE chosen address to take in everything handed to this person,
   *  wherever it sits. Null everywhere else.
   *
   *  It exists because there is no "Assigned to me" screen any more: what is on
   *  somebody's desk belongs in the address they open on rather than in a
   *  separate list they have to remember to check. Only ever set alongside
   *  `inboxId`, and only for the reader's OWN address - an inbox somebody is
   *  merely passing through has no business showing them work filed elsewhere.
   *
   *  It widens the chosen address and nothing else. The visibility clause is a
   *  separate AND, so a conversation handed to somebody in an address they may
   *  not read stays exactly as invisible as it was. */
  alsoAssignedTo?: string | null
  search?: string | null
  /** The search dialog's narrower cuts. Each one asks the conversation whether
   *  ANY message in it matches, which is the only reading that makes sense of a
   *  thread: "from the supplier" and "about the invoice" are usually two
   *  different messages of the same conversation. */
  fromText?: string | null
  toText?: string | null
  subjectText?: string | null
  withAttachment?: boolean
  /** The two ends of a date range, as instants. Worked out from the calendar
   *  dates in the address by the caller, in the SITE's timezone - a date turned
   *  into an instant here would be a date in UTC, which is an hour out for most
   *  of the British year and would quietly drop the first message of a day. */
  after?: Date | null
  before?: Date | null
  /** Which end of the list to start at. Newest first is what a mail program
   *  does; oldest first is for working a backlog off the bottom, which is the
   *  only way to clear one without the top moving under you. */
  oldestFirst?: boolean
  page: number
  perPage: number
}

/** The four states a conversation is in, plus the queue: 'unassigned' is the
 *  open ones nobody has taken, which is a cut across 'open' rather than a fifth
 *  value the column ever holds. Kept in this slot rather than in `assignee`
 *  because it is what the tab row asks for - see StatusFilter in lib/list.ts. */
export type ThreadStatusFilter = 'open' | 'snoozed' | 'done' | 'all' | 'unassigned'

export type ThreadListRow = {
  id: string
  inboxId: string | null
  /** Whoever the hub has worked out is on the other end, when it has. Only used
   *  to ask for their picture - everything shown about them on a row comes from
   *  the message itself. Null on automatic mail and on anything from one of the
   *  site's own addresses. */
  personId: string | null
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
  /** When the conversation was opened. The list itself never shows it - it is
   *  ordered by when something last arrived - but merging needs it: the
   *  conversation that STARTED an exchange is the one the others fold into, and
   *  the screen has to be able to say which that is before anybody presses the
   *  button. */
  createdAt: Date
  /** Every address the conversation belongs to, where a merge has given it more
   *  than one - or, on a discussion, where it was put to colleagues who have an
   *  address of their own. Empty on everything else. */
  absorbedInboxIds: string[]
  /** Who started a discussion. Null on every other channel, where the sending
   *  end is an address rather than a colleague. */
  startedByUserId: string | null
  /** The colleagues a discussion was put to. Empty on every other channel. */
  toUserIds: string[]
  /** The other party. Taken from their newest message to us where there is
   *  one, because that is the only place their NAME appears - our own replies
   *  carry an address and nothing else - and from the newest thing we sent them
   *  otherwise, which is all there is to go on. */
  participantName: string | null
  participantAddress: string | null
  hasAttachments: boolean
}

/**
 * "This conversation belongs to one of these addresses."
 *
 * Its own inbox, or any address a merge has since added to it. Written once
 * because the guest list, the chosen tab and the unread tallies all ask it, and
 * a merged conversation that showed in one of the three and not the others
 * would look like a conversation that had gone missing.
 */
function inboxMatch(inboxIds: string[]): Prisma.Sql {
  return Prisma.sql`(
    t."inbox_id" IN (${Prisma.join(inboxIds)})
    OR EXISTS (
      SELECT 1 FROM "uin_thread_inboxes" ti
       WHERE ti."thread_id" = t."id" AND ti."inbox_id" IN (${Prisma.join(inboxIds)})
    )
  )`
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
    parts.push(inboxMatch(inboxIds))
  }
  if (includeUnrouted) {
    // Mail that reached the account and matched none of the site's addresses.
    // A chat or an enquiry also sits in no inbox and must NOT fall in here:
    // "not filed" means an email nobody could place, and a channel that never
    // had an address to be placed by is a different thing entirely.
    parts.push(Prisma.sql`(t."inbox_id" IS NULL AND t."provider_module" IS NULL)`)
  }
  if (providerModules.length > 0) {
    // A channel's own conversations, and only the ones it addressed at nothing.
    // An enquiry a form addressed at sales@ is ordinary filed post from the
    // moment it lands: it is reached through the inbox clause above, by the
    // people that inbox is open to, and counted there once rather than in two
    // places at once.
    parts.push(Prisma.sql`(t."provider_module" IN (${Prisma.join(providerModules)}) AND t."inbox_id" IS NULL)`)
  }
  // Nothing visible at all. The caller returns an empty page rather than
  // running a query whose WHERE clause would be empty and therefore true.
  if (parts.length === 0) return null
  return Prisma.sql`(${Prisma.join(parts, ' OR ')})`
}

/**
 * "Somebody whose junk folder this conversation belongs in has thrown it away."
 *
 * Written once and used by the list, the counts and the unread tallies, because
 * three copies of a rule this shaped is three copies that drift - and a drifted
 * copy here means junk out of the list and still in the number beside it.
 *
 * TWO PEOPLE CAN HAVE THROWN IT AWAY, and they are not the same person.
 *
 *   The reader themselves. Junk is one person's opinion, so a conversation in a
 *   SHARED address that Sam files as junk leaves Sam's lists and nobody else's.
 *
 *   The owner of an individual address the conversation sits in. A colleague's
 *   own post is theirs, and somebody covering it while they are away is trying
 *   to see what THEY would see - so junk filed in Sam's address is gone from
 *   Sam's lists and from the lists of everybody covering Sam. Covering somebody
 *   and reading over their shoulder are the same job; a bin that only emptied
 *   for one of them would have the coverer working through post Sam has already
 *   dealt with.
 *
 * OR NOBODY DID, because the site turned the sender away at the door. That is
 * the `blocked_at` half, and it is deliberately not a person: a block is one
 * list for the whole site rather than an opinion, so post refused by it is out
 * of EVERYBODY'S lists. Nobody pressed anything, so there is no colleague to
 * attribute it to - and the one who blocked the address six months ago may
 * since have left. See migration 044.
 *
 * The inner half only ever runs for a conversation that HAS a junk mark, which
 * on any real site is a tiny fraction of them - the outer NOT EXISTS is an index
 * scan on the (thread_id, user_id) primary key and stops there for everything
 * else. So the cost is bounded by how much junk there is, not by how much post.
 */
function spamMatch(viewerUserId: string): Prisma.Sql {
  return Prisma.sql`(t."blocked_at" IS NOT NULL OR EXISTS (
    SELECT 1 FROM "uin_thread_spam" sp
     WHERE sp."thread_id" = t."id"
       AND (
         sp."user_id" = ${viewerUserId}
         OR sp."user_id" IN (
              SELECT i."owner_user_id" FROM "uin_inboxes" i
               WHERE i."kind" = 'individual'
                 AND i."owner_user_id" IS NOT NULL
                 AND (
                   i."id" = t."inbox_id"
                   OR EXISTS (
                        SELECT 1 FROM "uin_thread_inboxes" ti
                         WHERE ti."thread_id" = t."id" AND ti."inbox_id" = i."id"
                      )
                 )
            )
       )
  ))`
}

/**
 * One named person's spam folder, which is a different question from the one
 * above.
 *
 * The folder lists what is in THAT person's bin and nothing else. Not the wider
 * rule: a colleague covering Sam sees Sam's junk under Sam's name on the rail,
 * and their own under their own, and the two lists stay two lists. Answering
 * this with spamMatch() would put every colleague's junk into everybody's own
 * spam folder, which is the one place on the screen where a stranger's rubbish
 * has no business appearing.
 *
 * WITH ONE EXCEPTION, which is what the `blocked_at` clause is. Post the site
 * refused at the door belongs to nobody in particular, so there is no one bin
 * to put it in - it shows in the Spam folder of anybody who can see the
 * conversation at all, under whichever name they opened the folder on. That is
 * not a stranger's rubbish appearing in your bin: it is the site's own, and it
 * is the only place on the screen it appears at all. What somebody may see is
 * settled the same way it always is, by the visibility clause this sits beside
 * in one WHERE - so a refused conversation in an address you cannot open is
 * still not yours to read.
 */
function spamFolderMatch(ownerUserId: string): Prisma.Sql {
  return Prisma.sql`(t."blocked_at" IS NOT NULL OR EXISTS (
    SELECT 1 FROM "uin_thread_spam" sp
     WHERE sp."thread_id" = t."id" AND sp."user_id" = ${ownerUserId}
  ))`
}

function filterClauses(f: ThreadListFilters): Prisma.Sql[] {
  const where: Prisma.Sql[] = []
  // A conversation that lost a merge is not a conversation any more. It is kept
  // so the merge can be undone and holds nothing but the duplicates the merge
  // could not move, and every list, count and tally in this file goes through
  // here - which is the point of putting it here rather than in each of them.
  where.push(Prisma.sql`t."merged_into_id" IS NULL`)
  // Junk is out of every list but the bin it went into. Here rather than in
  // each of the callers, for the same reason the merge clause above is here: a
  // junk conversation that fell out of the list and stayed in the count beside
  // it is exactly the sort of disagreement a spam folder must not have.
  //
  // The folder itself asks a NARROWER question than the hiding does - see the
  // two builders above. Hiding covers "anybody whose bin this belongs in";
  // the folder is one named person's bin and nobody else's.
  if (f.spamOnly) {
    // Absent means "my own bin"; an explicit null means "a bin that belongs to
    // nobody", which is what a folder scoped to a shared address or to an id
    // this reader may not open resolves to. Those two must not collapse into
    // one, so it is `undefined` that falls back and null that yields nothing -
    // the same rule the rest of this screen follows for a scope that will not
    // resolve (E17). Falling back there would draw the reader's OWN junk under
    // a heading with a colleague's name on it.
    //
    // A bin belonging to nobody stays empty even of the post the site refused,
    // which is the same rule read once more rather than an exception to it: an
    // id this reader may not open must yield nothing at all, and ORing the
    // site-wide stamp in here is how "nothing at all" quietly becomes "nothing
    // except the interesting part".
    const owner = f.spamOwnerUserId === undefined ? f.viewerUserId : f.spamOwnerUserId
    where.push(owner === null ? Prisma.sql`false` : spamFolderMatch(owner))
  } else {
    where.push(Prisma.sql`NOT ${spamMatch(f.viewerUserId)}`)
  }
  if (f.unroutedOnly) {
    where.push(Prisma.sql`t."inbox_id" IS NULL AND t."provider_module" IS NULL`)
  } else if (f.providerModule) {
    // Same rule as the visibility clause: the channel's entry lists what was
    // addressed at no inbox. What a form sent to sales@ is in sales@.
    where.push(Prisma.sql`t."provider_module" = ${f.providerModule} AND t."inbox_id" IS NULL`)
  } else if (f.inboxId) {
    // The merged conversation shows in EVERY address's tab, which is what
    // merging across two of them was asked for.
    const here = inboxMatch([f.inboxId])
    // And, on the address this person opens on, whatever has been put on their
    // desk from anywhere else they can read. See `alsoAssignedTo` above.
    where.push(f.alsoAssignedTo
      ? Prisma.sql`(${here} OR t."assignee_user_id" = ${f.alsoAssignedTo})`
      : here)
  }
  if (f.status === 'unassigned') {
    // The queue on a shared address: open, and on nobody's desk. Both halves
    // here rather than one of them left to `assignee`, so the tab means one
    // thing wherever it is asked from - the list, the count beside it and the
    // paging all come through this function, and a tab whose count was drawn
    // from a different WHERE than its list is the disagreement worth avoiding.
    where.push(Prisma.sql`t."status" = 'open' AND t."assignee_user_id" IS NULL`)
  } else if (f.status && f.status !== 'all') {
    where.push(Prisma.sql`t."status" = ${f.status}`)
  }
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
  // The narrower cuts, one EXISTS each. Separate rather than folded into one
  // subquery on purpose: "from the supplier" and "with something attached" are
  // usually two different messages of the same conversation, and one subquery
  // would insist on finding them in the same one.
  //
  // ILIKE rather than the search index, because these are asked of an address
  // and a subject line, where somebody types half of one and expects the middle
  // of a word to count. The words themselves still go through the index above,
  // which is the clause that does the heavy lifting.
  const from = likeContains(f.fromText)
  if (from) {
    where.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "uin_messages" ms
       WHERE ms."thread_id" = t."id"
         AND (ms."from_address" ILIKE ${from} OR ms."from_name" ILIKE ${from})
    )`)
  }
  const to = likeContains(f.toText)
  if (to) {
    // Copied-in addresses count: somebody looking for what went to accounts@
    // means the mail accounts@ was on, not only the mail it was the first name
    // on. array_to_string rather than unnest so the whole thing is one
    // predicate over the row rather than a second correlated query.
    where.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "uin_messages" ms
       WHERE ms."thread_id" = t."id"
         AND array_to_string(ms."to_addresses" || ms."cc_addresses", ' ') ILIKE ${to}
    )`)
  }
  const subject = likeContains(f.subjectText)
  if (subject) {
    // The conversation's own subject as well as its messages': a thread carries
    // the subject it was opened with, and a reply whose subject somebody edited
    // should still be found under either.
    where.push(Prisma.sql`(t."subject" ILIKE ${subject} OR EXISTS (
      SELECT 1 FROM "uin_messages" ms
       WHERE ms."thread_id" = t."id" AND ms."subject" ILIKE ${subject}
    ))`)
  }
  if (f.withAttachment) {
    // Asked of the messages rather than read off the newest one: the invoice is
    // attached to the message that carried it, and the conversation has usually
    // moved on since.
    where.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "uin_messages" ms
       WHERE ms."thread_id" = t."id" AND ms."has_attachments" = true
    )`)
  }
  // Asked of when the conversation last moved, which is what the list is
  // ordered by and what the date on a row says - so a range narrows the list
  // somebody is looking at rather than a column they cannot see.
  if (f.after) where.push(Prisma.sql`t."last_message_at" >= ${f.after}`)
  if (f.before) where.push(Prisma.sql`t."last_message_at" < ${f.before}`)
  return where
}

/**
 * A contains-match for ILIKE, with the wildcards in what somebody typed taken
 * literally.
 *
 * An unescaped `%` in a search box is a search for everything, and an
 * unescaped `_` quietly matches any character - neither is what a person
 * hunting for "50%_off" means. Backslash is the escape ILIKE uses by default,
 * so it has to go first or escaping the wildcards would leave a dangling one.
 *
 * Exported for the tests: this is the piece with a genuine wrong answer in it.
 */
export function likeContains(raw: string | null | undefined): string | null {
  const value = raw?.trim()
  if (!value) return null
  return `%${value.replace(/\\/g, '\\\\').replace(/[%_]/g, (c) => `\\${c}`)}%`
}

/**
 * The order a list of conversations is drawn in. Written once each because the
 * page and the join below both have to agree about it - the page is taken
 * BEFORE the join (see below), so a query that sorted the two halves differently
 * would show twenty-five rows chosen by one rule and ordered by another.
 *
 * TWO CONSTANTS RATHER THAN A BUILT STRING, and that is the whole of the safety
 * argument: nothing a reader types ever reaches an ORDER BY, because the only
 * two orders that exist are written out here in full and the caller picks one of
 * them with a boolean.
 *
 * NULLS goes the other way round with the sort, which is not decoration:
 * last_message_at is null on a conversation nothing has arrived in yet, and
 * those belong at the far end from the newest either way round.
 *
 * SORTED ON WHEN THE POST ARRIVED, not only on when it was written. The two are
 * the same thing for ordinary mail and part company the moment somebody files
 * an email into a watched folder by hand: it is dated when it was written and
 * reaches us hours later, and ordering on the date alone drops it into the
 * middle of the list where nobody is looking. See migration 045 - that is a
 * real conversation on the live site, not a hypothetical.
 *
 * last_arrived_at is null on every conversation this has never happened to,
 * which is nearly all of them, and GREATEST ignores nulls - so for those the
 * first key IS last_message_at and the order is exactly what it always was. The
 * second key is what keeps it that way: two conversations that arrived in the
 * same sweep fall back to the date on the mail, rather than to whichever the
 * collector happened to reach first.
 */
const THREAD_LIST_ORDER = Prisma.sql`GREATEST(t."last_message_at", t."last_arrived_at") DESC NULLS LAST, t."last_message_at" DESC NULLS LAST, t."id" DESC`
const THREAD_LIST_ORDER_OLDEST = Prisma.sql`GREATEST(t."last_message_at", t."last_arrived_at") ASC NULLS FIRST, t."last_message_at" ASC NULLS FIRST, t."id" ASC`

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
function threadListQuery(
  where: Prisma.Sql[],
  limit: number,
  offset: number,
  oldestFirst = false,
): Prisma.Sql {
  const order = oldestFirst ? THREAD_LIST_ORDER_OLDEST : THREAD_LIST_ORDER
  return Prisma.sql`
    SELECT t."id", t."inbox_id", t."person_id", t."channel", t."provider_module", t."subject",
           t."preview", t."status", t."snooze_until", t."assignee_user_id",
           t."last_message_at", t."last_direction", t."unread", t."message_count",
           t."created_at", t."started_by_user_id", t."to_user_ids",
           COALESCE(
             ARRAY(SELECT ti."inbox_id" FROM "uin_thread_inboxes" ti WHERE ti."thread_id" = t."id"),
             ARRAY[]::text[]
           ) AS "absorbed_inbox_ids",
           lm."from_name"        AS "last_from_name",
           lm."from_address"     AS "last_from_address",
           lm."from_phone"       AS "last_from_phone",
           lm."to_addresses"     AS "last_to",
           lm."direction"        AS "last_direction_message",
           lm."has_attachments"  AS "last_has_attachments"
      FROM (
        SELECT t.* FROM "uin_threads" t
         WHERE ${Prisma.join(where, ' AND ')}
         ORDER BY ${order}
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
     ORDER BY ${order}`
}

function mapThreadListRow(r: Record<string, unknown>): ThreadListRow {
  const direction = (r.last_direction_message as string | null) ?? null
  const to = (r.last_to as string[] | null) ?? []
  const inbound = direction !== 'out'
  return {
    id: r.id as string,
    inboxId: (r.inbox_id as string | null) ?? null,
    personId: (r.person_id as string | null) ?? null,
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
    createdAt: r.created_at as Date,
    absorbedInboxIds: (r.absorbed_inbox_ids as string[] | null) ?? [],
    startedByUserId: (r.started_by_user_id as string | null) ?? null,
    toUserIds: (r.to_user_ids as string[] | null) ?? [],
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
    threadListQuery(where, f.perPage, offset, f.oldestFirst ?? false),
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
  /** Who is looking. First rather than last so that no existing call site can
   *  keep compiling without saying - the numbers on the rail are one person's
   *  numbers, and junk this person threw away must not go on counting against
   *  the address they threw it out of. */
  viewerUserId: string,
  inboxIds: string[],
  includeUnrouted: boolean,
  providerModules: string[] = [],
): Promise<Record<string, number>> {
  const visible = visibilityClause(inboxIds, includeUnrouted, providerModules)
  if (!visible) return {}
  // The join is what makes a merged conversation count once under EVERY address
  // it belongs to, so the tab a colleague is looking at agrees with the list
  // behind it. LEFT, because a conversation that has never been merged has no
  // rows here at all and must still be counted under its own inbox - which is
  // every conversation on nearly every site.
  const restrict = inboxIds.length > 0
    ? Prisma.sql`AND (ti."inbox_id" IS NULL OR ti."inbox_id" IN (${Prisma.join(inboxIds)}))`
    : Prisma.empty
  const rows = await prisma.$queryRaw<{ key: string | null; count: bigint }[]>`
    SELECT COALESCE(ti."inbox_id", t."inbox_id", 'm:' || t."provider_module") AS "key",
           COUNT(*)::bigint AS "count"
      FROM "uin_threads" t
      LEFT JOIN "uin_thread_inboxes" ti ON ti."thread_id" = t."id"
     WHERE ${visible}
       AND t."merged_into_id" IS NULL
       AND t."unread" = true
       AND t."status" <> 'done'
       AND NOT ${spamMatch(viewerUserId)}
       ${restrict}
     GROUP BY COALESCE(ti."inbox_id", t."inbox_id", 'm:' || t."provider_module")
  `
  const out: Record<string, number> = {}
  for (const r of rows) out[r.key ?? ''] = Number(r.count)
  return out
}

/**
 * How much is on this person's desk that is filed somewhere OTHER than their
 * own address.
 *
 * The number that has to be added to their own address on the rail, because
 * standing in it now shows them that work as well (see `alsoAssignedTo`) and a
 * count that disagreed with the list under it would send somebody hunting for a
 * message that was never missing.
 *
 * Its own query rather than another key in the tally above, for two reasons. A
 * conversation in accounts@ handed to this person belongs to accounts@ AND to
 * their desk, and one grouped row cannot be in two places. And the All entry is
 * the sum of that tally - so an inflated row in it would make the number beside
 * All larger than the number of conversations there are.
 */
export async function unreadAssignedElsewhere(
  viewerUserId: string,
  inboxIds: string[],
  includeUnrouted: boolean,
  providerModules: string[],
  ownInboxId: string,
): Promise<number> {
  const visible = visibilityClause(inboxIds, includeUnrouted, providerModules)
  if (!visible) return 0
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS "count"
      FROM "uin_threads" t
     WHERE ${visible}
       AND t."merged_into_id" IS NULL
       AND t."unread" = true
       AND t."status" <> 'done'
       AND t."assignee_user_id" = ${viewerUserId}
       AND NOT ${inboxMatch([ownInboxId])}
       AND NOT ${spamMatch(viewerUserId)}
  `
  return Number(rows[0]?.count ?? 0)
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
  const rows = await prisma.$queryRaw<{ status: string; count: bigint; nobody: bigint }[]>`
    SELECT t."status" AS "status",
           COUNT(*)::bigint AS "count",
           COUNT(*) FILTER (WHERE t."assignee_user_id" IS NULL)::bigint AS "nobody"
      FROM "uin_threads" t
     WHERE ${Prisma.join(where, ' AND ')}
     GROUP BY t."status"
  `
  const out: Record<string, number> = {}
  let all = 0
  for (const r of rows) {
    out[r.status] = Number(r.count)
    all += Number(r.count)
    // The queue's own number, off the same pass rather than a second query: it
    // is the open ones with nobody on them, so it comes out of the open row and
    // is deliberately NOT added into `all` - every one of them is already
    // counted there once, as an open conversation.
    if (r.status === 'open') out.unassigned = Number(r.nobody)
  }
  out.all = all
  return out
}

export type ThreadDetail = {
  id: string
  inboxId: string | null
  /** Every address this conversation belongs to. Empty until a merge spans two
   *  of them - see ThreadRow.absorbedInboxIds. */
  absorbedInboxIds: string[]
  /** Set on the losing side of a merge. A conversation with this set is not
   *  shown in any list; it is kept so the merge can be put back. */
  mergedIntoId: string | null
  channel: string
  providerModule: string | null
  externalId: string | null
  /** What on the site this came from, in the owning channel's own words -
   *  which form, which widget. Null on everything that has nothing to add to
   *  the name of the channel itself, which is most conversations. */
  sourceLabel: string | null
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
    SELECT t.*, ${ABSORBED_INBOX_IDS} AS absorbed_inbox_ids
      FROM "uin_threads" t WHERE t."id" = ${id}
  `
  const r = rows[0]
  if (!r) return null
  return {
    id: r.id as string,
    inboxId: (r.inbox_id as string | null) ?? null,
    absorbedInboxIds: (r.absorbed_inbox_ids as string[] | null) ?? [],
    mergedIntoId: (r.merged_into_id as string | null) ?? null,
    channel: r.channel as string,
    providerModule: (r.provider_module as string | null) ?? null,
    externalId: (r.external_id as string | null) ?? null,
    sourceLabel: (r.source_label as string | null) ?? null,
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

/**
 * The other party's number on an open conversation, for a text or a call
 * started while looking at it.
 *
 * Newest first, because a number is a thing people change, and only ever from
 * a message they sent US: `from_phone` on our own outgoing message is our own
 * number, and ringing ourselves is not what anybody meant by "call them".
 */
export async function latestPhoneOnThread(threadId: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ from_phone: string | null }[]>`
    SELECT "from_phone" FROM "uin_messages"
     WHERE "thread_id" = ${threadId}
       AND "direction" = 'in'
       AND "from_phone" IS NOT NULL
     ORDER BY "sent_at" DESC
     LIMIT 1
  `
  return rows[0]?.from_phone ?? null
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
    remoteImages: remoteImageUrls(readableHtml(html)).length,
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
  /** The conversation it is on. Carried so the access check can consult a tag
   *  as well as a guest list - see ThreadShape in lib/access.ts. */
  threadId: string
  inboxId: string | null
  // Which channel owns it, when another module does. A message with neither an
  // inbox nor a channel is an email nobody could place, which is a different
  // question about who may read it - see threadAccessKind in lib/access.ts.
  providerModule: string | null
  subject: string | null
} | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT m."body_html", m."body_text", m."subject", m."inbox_id",
           m."thread_id", t."inbox_id" AS "thread_inbox_id", t."provider_module"
      FROM "uin_messages" m
      JOIN "uin_threads" t ON t."id" = m."thread_id"
     WHERE m."id" = ${id}
  `
  const r = rows[0]
  if (!r) return null
  return {
    html: readableHtml(r.body_html as string | null),
    text: (r.body_text as string | null) ?? null,
    threadId: r.thread_id as string,
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
  | 'woken'
  | 'status'
  | 'note'
  | 'mentioned'
  | 'linked'
  | 'unlinked'
  | 'merged'
  /** A merge was put back. Recorded against the conversation that had absorbed
   *  the other, which is the one still there to be looked at. */
  | 'unmerged'
  /** Mail arrived from somebody a scheduled message was addressed to, so that
   *  message was stood down before it could ask a question that had already
   *  been answered. */
  | 'held'
  /** A scheduled message went out carrying a follow-up, so the conversation was
   *  put to sleep until the chase is due. */
  | 'awaiting'

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

/**
 * Give a conversation to somebody, but only while nobody has it. True when it
 * took, false when it was already spoken for.
 *
 * The emptiness is checked in the same statement that fills it, deliberately.
 * The caller is the collecting pass (lib/own-post.ts), which is the one place
 * in this module where two ticks can be filing mail on the same conversation at
 * the same moment - and a read followed by a write would let the second one
 * take a conversation off the person the first one gave it to.
 */
export async function assignThreadIfUnassigned(threadId: string, userId: string): Promise<boolean> {
  const changed = await prisma.$executeRaw`
    UPDATE "uin_threads"
       SET "assignee_user_id" = ${userId}, "updated_at" = now()
     WHERE "id" = ${threadId} AND "assignee_user_id" IS NULL
  `
  return changed > 0
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

/** Where a conversation stands and, when it is asleep, what time it is due
 *  back. Its own small read rather than a field on getThread: the one caller is
 *  the scheduled sender, which reads it either side of posting a message so
 *  that a message going out does not quietly wake a conversation somebody put
 *  to sleep until Thursday. */
export async function threadSleep(
  threadId: string,
): Promise<{ status: string; snoozeUntil: Date | null } | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "status", "snooze_until" FROM "uin_threads" WHERE "id" = ${threadId}
  `
  const r = rows[0]
  if (!r) return null
  return {
    status: r.status as string,
    snoozeUntil: (r.snooze_until as Date | null) ?? null,
  }
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

/** What a conversation was before a reply put it back in Open. Null when it
 *  was already there and nothing happened. */
export type ReopenedFrom = 'snoozed' | 'done' | null

/**
 * One conversation put back in Open, because somebody has written on it.
 *
 * Both of the ways a conversation leaves Open are statements about silence.
 * "Come back to me on Thursday" says nothing will happen before Thursday, and
 * "done" says nothing more will happen at all. A reply contradicts both, so
 * both are reversed by one rule rather than two - it is easier to explain and
 * there is no second case to forget about.
 *
 * Done is the one that matters more, which is not obvious. A snoozed
 * conversation comes back on its own on Thursday. A done one never does, and
 * the unread badge on the address tabs deliberately skips done conversations
 * (see unreadCounts) - so a customer's reply to something we had finished with
 * used to sit at the top of a tab nobody opens, unread, badgeless, indefinitely.
 * That is the failure this exists to prevent.
 *
 * Deliberately narrower than wakeDueThreads: one row, named, and only when it
 * is not already open. `AND "status" <> 'open'` is what makes it safe to call on
 * every message that lands - an open conversation is not rewritten, and two
 * ticks racing cost one no-op.
 *
 * Returns what it was, so the caller can say which of the two happened, and so
 * that an already-open conversation writes no timeline entry at all rather than
 * one per polled message. The status is read in the CTE, before the UPDATE,
 * because RETURNING would hand back the value we have just written. FOR UPDATE
 * is what settles the race: the second tick blocks, re-reads, finds the row
 * open and matches nothing.
 */
export async function reopenOnReply(threadId: string): Promise<ReopenedFrom> {
  const rows = await prisma.$queryRaw<{ was: string }[]>`
    WITH "before" AS (
      SELECT "id", "status"
        FROM "uin_threads"
       WHERE "id" = ${threadId} AND "status" <> 'open'
         FOR UPDATE
    )
    UPDATE "uin_threads" t
       SET "status" = 'open', "snooze_until" = NULL, "updated_at" = now()
      FROM "before"
     WHERE t."id" = "before"."id"
    RETURNING "before"."status" AS "was"
  `
  const was = rows[0]?.was
  return was === 'snoozed' || was === 'done' ? was : null
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
// Being asked to look at something.
//
// One row per person per conversation (migrations/032_mentions.sql), with its
// own open / snoozed / done. The conversation's own status is a different fact
// and is never touched from here: that one is shared, and three colleagues
// asked about one order would otherwise settle it from under each other.
//
// Every read is scoped to one user id, in the SQL rather than after it. The
// same rule the lists follow (E17), and for the same reason: this table is the
// one place that knows a colleague was let into a conversation their inbox
// guest list does not cover.
// ---------------------------------------------------------------------------

/** Is this colleague one of the people asked to look at this conversation?
 *  Asked on every request against a conversation somebody may not otherwise
 *  open, so it is one indexed lookup and nothing else. */
export async function hasMentionOn(threadId: string, userId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ one: number }[]>`
    SELECT 1 AS "one" FROM "uin_mentions"
     WHERE "thread_id" = ${threadId} AND "user_id" = ${userId}
     LIMIT 1
  `
  return rows.length > 0
}

/**
 * Ask somebody to look at a conversation.
 *
 * Asked again about the same one, they get the SAME piece of work back rather
 * than a second one beside it - so a colleague who marked theirs done a
 * fortnight ago and has been asked again finds it waiting, open, with the new
 * note against it. That is what the unique index on (thread_id, user_id) is
 * for, and why this is an upsert rather than an insert.
 */
export async function upsertMention(data: {
  threadId: string
  userId: string
  byUserId: string
  messageId: string | null
  note: string | null
}): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "uin_mentions" ("thread_id", "user_id", "by_user_id", "message_id", "note")
    VALUES (${data.threadId}, ${data.userId}, ${data.byUserId}, ${data.messageId}, ${data.note})
    ON CONFLICT ("thread_id", "user_id") DO UPDATE
       SET "by_user_id"   = EXCLUDED."by_user_id",
           "message_id"   = EXCLUDED."message_id",
           "note"         = EXCLUDED."note",
           "status"       = 'open',
           "snooze_until" = NULL,
           "settled_at"   = NULL,
           "updated_at"   = now()
  `
}

/** One ask, as the list and the badge in a conversation's header need it. */
export type MentionRow = {
  id: string
  threadId: string
  status: string
  snoozeUntil: Date | null
  note: string | null
  byUserId: string | null
  createdAt: Date
  /** The conversation it is about, in the little a row needs to say which. */
  subject: string | null
  channel: string
  inboxId: string | null
  providerModule: string | null
  lastMessageAt: Date | null
  participantName: string | null
  participantAddress: string | null
}

function mapMentionRow(r: Record<string, unknown>): MentionRow {
  const direction = (r.last_direction as string | null) ?? null
  const to = (r.last_to as string[] | null) ?? []
  const inbound = direction !== 'out'
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    status: r.status as string,
    snoozeUntil: (r.snooze_until as Date | null) ?? null,
    note: (r.note as string | null) ?? null,
    byUserId: (r.by_user_id as string | null) ?? null,
    createdAt: r.created_at as Date,
    subject: (r.subject as string | null) ?? null,
    channel: r.channel as string,
    inboxId: (r.inbox_id as string | null) ?? null,
    providerModule: (r.provider_module as string | null) ?? null,
    lastMessageAt: (r.last_message_at as Date | null) ?? null,
    participantName: inbound ? ((r.last_from_name as string | null) ?? null) : null,
    participantAddress: inbound
      ? ((r.last_from_address as string | null) ?? (r.last_from_phone as string | null) ?? null)
      : (to[0] ?? (r.last_from_phone as string | null) ?? null),
  }
}

/** 'all' means every one of them, which is the status tabs' fourth choice. */
export type MentionStatusFilter = 'open' | 'snoozed' | 'done' | 'all'

function mentionStatusClause(status: MentionStatusFilter): Prisma.Sql {
  return status === 'all' ? Prisma.sql`TRUE` : Prisma.sql`x."status" = ${status}`
}

/**
 * Whose asks, and optionally on which address.
 *
 * The address half is what the Mentioned folder under a colleague's name on the
 * rail asks for: not everything that person has ever been tagged in, which
 * would reach into inboxes the reader has no business in, but the asks on the
 * one address they were let in to. Scoped in the SQL beside the user id rather
 * than filtered afterwards, for the same reason every other list on this screen
 * is (E17).
 *
 * `inboxMatch` rather than a bare column test, so a conversation merged across
 * two addresses is in the folder of both of them - which is what merging across
 * them was asked for, and what the conversation lists themselves already do.
 */
function mentionScope(userId: string, inboxId: string | null): Prisma.Sql {
  const mine = Prisma.sql`x."user_id" = ${userId}`
  return inboxId ? Prisma.sql`${mine} AND ${inboxMatch([inboxId])}` : mine
}

/**
 * What one colleague has been asked to look at.
 *
 * Ordered by when they were asked rather than by when the conversation last
 * moved: this is somebody's own list of jobs, and the oldest ask is the one
 * that has been waiting longest whatever the customer has been doing since.
 */
export async function listMentions(f: {
  userId: string
  status: MentionStatusFilter
  page: number
  perPage: number
  /** One address, for a colleague's Mentioned folder; null for everything this
   *  person has been asked about, wherever it sits. */
  inboxId?: string | null
}): Promise<MentionRow[]> {
  const offset = Math.max(0, (f.page - 1) * f.perPage)
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT x."id", x."thread_id", x."status", x."snooze_until", x."note", x."by_user_id",
           x."created_at",
           t."subject", t."channel", t."inbox_id", t."provider_module", t."last_message_at",
           lm."from_name"    AS "last_from_name",
           lm."from_address" AS "last_from_address",
           lm."from_phone"   AS "last_from_phone",
           lm."to_addresses" AS "last_to",
           lm."direction"    AS "last_direction"
      FROM "uin_mentions" x
      JOIN "uin_threads" t ON t."id" = x."thread_id"
      LEFT JOIN LATERAL (
        SELECT m."from_name", m."from_address", m."from_phone", m."to_addresses", m."direction"
          FROM "uin_messages" m
         WHERE m."thread_id" = t."id" AND m."direction" <> 'note'
         ORDER BY (m."direction" = 'in') DESC, m."sent_at" DESC
         LIMIT 1
      ) lm ON true
     WHERE ${mentionScope(f.userId, f.inboxId ?? null)} AND ${mentionStatusClause(f.status)}
     ORDER BY x."created_at" DESC
     LIMIT ${f.perPage} OFFSET ${offset}
  `
  return rows.map(mapMentionRow)
}

export async function countMentions(
  userId: string,
  status: MentionStatusFilter,
  inboxId: string | null = null,
): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS "count" FROM "uin_mentions" x
      JOIN "uin_threads" t ON t."id" = x."thread_id"
     WHERE ${mentionScope(userId, inboxId)} AND ${mentionStatusClause(status)}
  `
  return Number(rows[0]?.count ?? 0)
}

/** All four numbers for the status tabs in one query rather than four. */
export async function mentionStatusCounts(
  userId: string,
  inboxId: string | null = null,
): Promise<Record<string, number>> {
  const rows = await prisma.$queryRaw<{ status: string; count: bigint }[]>`
    SELECT x."status", COUNT(*)::bigint AS "count" FROM "uin_mentions" x
      JOIN "uin_threads" t ON t."id" = x."thread_id"
     WHERE ${mentionScope(userId, inboxId)}
     GROUP BY x."status"
  `
  const out: Record<string, number> = { open: 0, snoozed: 0, done: 0, all: 0 }
  let all = 0
  for (const r of rows) {
    out[r.status] = Number(r.count)
    all += Number(r.count)
  }
  out.all = all
  return out
}

/** The number beside "Asked me" on the rail. Open only: a place with nothing
 *  waiting in it should read as empty, and something set aside until Thursday
 *  is not waiting. */
export async function openMentionCount(userId: string): Promise<number> {
  return await countMentions(userId, 'open')
}

/** This reader's own ask on one conversation, for the banner at the top of it.
 *  Nobody else's, ever: what a colleague was asked and whether they have got to
 *  it yet is between them and whoever asked. */
export async function mentionForThread(userId: string, threadId: string): Promise<MentionRow | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT x."id", x."thread_id", x."status", x."snooze_until", x."note", x."by_user_id",
           x."created_at",
           t."subject", t."channel", t."inbox_id", t."provider_module", t."last_message_at",
           NULL::text AS "last_from_name", NULL::text AS "last_from_address",
           NULL::text AS "last_from_phone", NULL::text[] AS "last_to",
           NULL::text AS "last_direction"
      FROM "uin_mentions" x
      JOIN "uin_threads" t ON t."id" = x."thread_id"
     WHERE x."user_id" = ${userId} AND x."thread_id" = ${threadId}
     LIMIT 1
  `
  const r = rows[0]
  return r ? mapMentionRow(r) : null
}

/**
 * Where one person's own ask stands.
 *
 * Scoped to the person in the UPDATE itself rather than checked first and
 * written afterwards: an id is guessable, and "settle somebody else's job for
 * them" is not a thing this module offers. Returns false when nothing matched,
 * which the route says out loud rather than pretending it worked.
 */
export async function setMentionStatus(input: {
  id: string
  userId: string
  status: 'open' | 'snoozed' | 'done'
  until: Date | null
}): Promise<boolean> {
  const changed = await prisma.$executeRaw`
    UPDATE "uin_mentions"
       SET "status"       = ${input.status},
           "snooze_until" = ${input.status === 'snoozed' ? input.until : null},
           "settled_at"   = ${input.status === 'done' ? new Date() : null},
           "updated_at"   = now()
     WHERE "id" = ${input.id} AND "user_id" = ${input.userId}
  `
  return changed > 0
}

/** Asks that were put off until now. The same sweep the conversations
 *  themselves get, run beside it. */
export async function wakeDueMentions(): Promise<number> {
  return prisma.$executeRaw`
    UPDATE "uin_mentions"
       SET "status" = 'open', "snooze_until" = NULL, "updated_at" = now()
     WHERE "status" = 'snoozed' AND "snooze_until" IS NOT NULL AND "snooze_until" <= now()
  `
}

// ---------------------------------------------------------------------------
// Drafts.
//
// A draft belongs to whoever wrote it, and to nobody else. Reading one, opening
// one, changing one, discarding one and sending one are all the same single
// question: is this yours. Sharing the address it is filed on grants none of
// them - a shared inbox shares what has been SENT and what has ARRIVED, and
// half-written text is not either of those. Somebody typing a price they have
// not checked, or an apology they have not decided to make, is entitled to the
// same privacy the same words get in every mail program written since the
// nineties, and that is what migrations/013_drafts.sql set out to build.
//
// This restores that. It was briefly widened so that a draft filed on an
// address could be read by everyone who could read the address, and finished by
// everyone who could send from it; the cost of the favour turned out to be that
// nothing anybody typed in a shared inbox was private, which is not a trade a
// colleague was ever asked to make.
//
// The price is the case that widening it was for: a draft whose author is on
// leave cannot be finished by anybody else, and one whose author is an agent
// waits for that agent. That is the same price every other mail program pays,
// and the way out of it is to send the message rather than to read somebody's
// unfinished sentence.
//
// The pure statement of the rule, with the tests, is canReadDraft/canEditDraft
// in lib/drafts.ts - change one and change the other.
//
// Authorship goes into the SQL for the same reason every other visibility rule
// in this file does (E17): it is ANDed into the query rather than applied to
// the rows afterwards, so a colleague's draft is never fetched and never
// counted on the tabs.
// ---------------------------------------------------------------------------

/** Whether a row out of the drafts table's `products` column is a reference we
 *  can actually go and look up. Nothing here trusts the column: it is jsonb,
 *  and the only thing jsonb guarantees is that it parsed. */
function isDraftProduct(value: unknown): value is DraftProduct {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return typeof row.moduleName === 'string' && row.moduleName.length > 0
    && (row.kind === 'product' || row.kind === 'variation')
    && typeof row.id === 'string' && row.id.length > 0
}

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
    bcc: (r.bcc_addresses as string[] | null) ?? [],
    subject: (r.subject as string | null) ?? null,
    body: (r.body as string | null) ?? '',
    // A value the check constraint could not have allowed is a row somebody has
    // been at by hand. Read as text, which is the reading that renders markup
    // harmlessly rather than the one that runs it.
    bodyFormat: r.body_format === 'html' ? 'html' : 'text',
    // jsonb comes back parsed, and can be any shape at all if somebody has been
    // at the table by hand. Anything that is not a list of files is no files.
    attachments: Array.isArray(r.attachments) ? (r.attachments as DraftAttachment[]) : [],
    // Same bargain as the attachments above, and the same reason: jsonb comes
    // back parsed and can be any shape at all if somebody has been at the table
    // by hand. Anything that is not a list of references is no products, and a
    // reference missing any of its three parts is dropped rather than carried
    // to a query that would then ask for undefined.
    products: Array.isArray(r.products)
      ? (r.products as unknown[]).filter(isDraftProduct)
      : [],
    sendAt: (r.send_at as Date | null) ?? null,
    // A state the column check could not have allowed is a row somebody has
    // been at by hand. Read as an ordinary draft, which is the state that does
    // nothing on its own.
    sendState: DRAFT_SEND_STATES.includes(r.send_state as Exclude<DraftSendState, null>)
      ? (r.send_state as DraftSendState)
      : null,
    sendError: (r.send_error as string | null) ?? null,
    // A column the check constraint could not have allowed is a row somebody
    // has been at by hand, and a follow-up nobody can read is no follow-up.
    followUpMinutes: typeof r.follow_up_minutes === 'number' ? r.follow_up_minutes : null,
    snoozeUntil: (r.snooze_until as Date | null) ?? null,
    heldByThreadId: (r.held_by_thread_id as string | null) ?? null,
    heldAt: (r.held_at as Date | null) ?? null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  }
}

/** This person's own drafts, and only those. The SQL twin of canReadDraft in
 *  lib/drafts.ts, and - since reading and changing are now the same question -
 *  of canEditDraft as well.
 *
 *  `inboxIds` narrows it further to the addresses named, for the Drafts folder
 *  looked at inside ONE address. Null means every one of this person's, which
 *  is what the Drafts folder on its own shows - including the ones with no
 *  address at all, left on a conversation another module owns.
 *
 *  Every query that uses this aliases the table `d`, the UPDATE and the DELETE
 *  included, so there is one spelling of the rule rather than two that have to
 *  be kept level with each other. */
function draftScope(userId: string, inboxIds: string[] | null = null): Prisma.Sql {
  const author = Prisma.sql`d."author_user_id" = ${userId}`
  if (inboxIds === null) return Prisma.sql`(${author})`
  return Prisma.sql`(${author} AND d."inbox_id" = ANY(${inboxIds}::text[]))`
}

/** A message with a time on it that has not been and gone: waiting for its
 *  moment, or being posted this second. These are the Scheduled folder, and
 *  they are deliberately NOT in Drafts - a message somebody has already decided
 *  about is not something they left half-written, and mixing the two made the
 *  Drafts count read as work outstanding when half of it was work done.
 *
 *  Written out as two comparisons rather than `IN`, and its opposite written
 *  out rather than negated, because `send_state` is NULL on every ordinary
 *  draft and `NOT (NULL IN (...))` is NULL - which is to say every ordinary
 *  draft would quietly fall out of the Drafts list. */
const DRAFT_WAITING = Prisma.sql`(d."send_state" = 'scheduled' OR d."send_state" = 'sending')`

/** And the rest, which is what Drafts is a list of: one nobody has put a time
 *  on, and one whose time came and whose send was refused. The second belongs
 *  here rather than under Scheduled - it is not going anywhere on its own any
 *  more, and it wants somebody to look at it. */
const DRAFT_NOT_WAITING = Prisma.sql`(d."send_state" IS NULL OR d."send_state" = 'failed')`

export async function listDrafts(
  userId: string,
  inboxIds: string[] | null = null,
): Promise<Draft[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT d.* FROM "uin_drafts" d
     WHERE ${draftScope(userId, inboxIds)} AND ${DRAFT_NOT_WAITING}
     ORDER BY d."updated_at" DESC
     LIMIT 200
  `
  return rows.map(mapDraft)
}

/** The other half of the same table: what is set to go out on its own.
 *
 *  Ordered by when it leaves rather than when it was last touched, because that
 *  is the question this list is asked - what goes next - and a message written
 *  this morning for next Tuesday would otherwise sit above one leaving in ten
 *  minutes. */
export async function listScheduledDrafts(
  userId: string,
  inboxIds: string[] | null = null,
): Promise<Draft[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT d.* FROM "uin_drafts" d
     WHERE ${draftScope(userId, inboxIds)} AND ${DRAFT_WAITING}
     ORDER BY d."send_at" ASC
     LIMIT 200
  `
  return rows.map(mapDraft)
}

/** How many of this person's are waiting on each address, for the Drafts folder
 *  under a colleague's name - which is only offered where there is something in
 *  it, so the count has to be known before the rail is drawn rather than after
 *  somebody has opened the folder.
 *
 *  Author-scoped like every other draft query, so the number under Sam's name is
 *  this reader's own writing on Sam's address and could never be Sam's own.
 *
 *  Drafts filed against no address are left out: there is no folder for them to
 *  appear under, and the Drafts tab itself already counts them.
 *
 *  One grouped query rather than one call per address: the rail is drawn on
 *  every list this hub renders, and a site with nine colleagues on it would
 *  otherwise ask the same question nine times. */
export async function countDraftsByInbox(userId: string): Promise<Record<string, number>> {
  const rows = await prisma.$queryRaw<{ inbox_id: string; count: bigint }[]>`
    SELECT d."inbox_id" AS "inbox_id", COUNT(*)::bigint AS "count"
      FROM "uin_drafts" d
     WHERE ${draftScope(userId)} AND ${DRAFT_NOT_WAITING} AND d."inbox_id" IS NOT NULL
     GROUP BY d."inbox_id"
  `
  const counts: Record<string, number> = {}
  for (const row of rows) counts[row.inbox_id] = Number(row.count)
  return counts
}

/** How many are waiting, for the number on the Drafts tab. */
export async function countDrafts(
  userId: string,
  inboxIds: string[] | null = null,
): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS "count" FROM "uin_drafts" d
     WHERE ${draftScope(userId, inboxIds)} AND ${DRAFT_NOT_WAITING}
  `
  return Number(rows[0]?.count ?? 0)
}

/** How many are set to go out on their own, for the number on the Scheduled
 *  tab - and for whether that tab is offered at all. Counted on every list this
 *  hub draws, so it is one COUNT over the partial index the queue already
 *  keeps. */
export async function countScheduledDrafts(
  userId: string,
  inboxIds: string[] | null = null,
): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS "count" FROM "uin_drafts" d
     WHERE ${draftScope(userId, inboxIds)} AND ${DRAFT_WAITING}
  `
  return Number(rows[0]?.count ?? 0)
}

// ---------------------------------------------------------------------------
// Sent.
//
// One row per message that left - the answer to "did that quote actually go,
// and when". Messages rather than conversations, because a long thread somebody
// has answered four times is four things sent, and a list that showed it once
// would be a list of conversations wearing a Sent label.
//
// TWO folders, asked of the same rows. The entry under Yours is a PERSON's: what
// this reader has sent, from their own address and from every shared one they
// write from. The entry under an address on the rail is that ADDRESS's:
// everything that has left sales@, whoever wrote it, including the mail a module
// sent on its own. `ownUserId` below is which of the two is being asked for.
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
 *
 * `ownUserId` is the difference between the two Sent folders on the rail. Null
 * is an ADDRESS's folder - everything that has left sales@, whoever wrote it,
 * which is what somebody opens it to see. A user id is a PERSON's - the entry
 * under Yours - and narrows it to their own writing wherever it went out from,
 * because a folder called Sent under your own name that holds a colleague's
 * replies is not your Sent folder at all.
 */
function sentWhere(
  inboxIds: string[],
  includeUnrouted: boolean,
  providerModules: string[],
  ownUserId: string | null,
): Prisma.Sql | null {
  const visible = visibilityClause(inboxIds, includeUnrouted, providerModules)
  if (!visible) return null
  const outbound = Prisma.sql`(m."direction" = 'out' AND ${visible})`
  const anybody = inboxIds.length === 0
    ? outbound
    : Prisma.sql`(${outbound} OR (m."direction" = 'in' AND lower(m."from_address") IN (
        SELECT lower(i."address") FROM "uin_inboxes" i WHERE i."id" IN (${Prisma.join(inboxIds)})
      ) AND ${notAlreadyListed(inboxIds)}))`
  return ownUserId ? Prisma.sql`(${anybody} AND ${writtenBy(ownUserId)})` : anybody
}

/**
 * Keeps the colleague-post clause above from listing a message TWICE.
 *
 * Mail between two of our own addresses is filed as two conversations - one for
 * the person who sent it and one for the person who got it, each marked done and
 * answered on its own (see internalSides in lib/addresses.ts). That is right for
 * the inbox and wrong for this list: a message sent once is one thing sent, and
 * the sender was seeing the row the send path wrote AND the copy the mail server
 * handed back, side by side, a second apart, saying the same words to the same
 * person. Ten of the sixty rows in one Sent folder here were the second half of
 * a pair.
 *
 * The two are tied together by the id the relay stamped on the way out: the
 * delivered copy's Message-ID is the outbound row's `provider_message_id` (a
 * service that leaves ours alone matches on the header instead). So an inbound
 * copy is dropped when the outbound row it is a copy OF is already in this list.
 *
 * Only when that row is one this reader can actually see, which is what the
 * inbox test is for - it is the sending address, and `insert_outbound` always
 * records it. A message that only ever existed as the delivered copy - written
 * on a phone, or in Outlook, where nothing here wrote a row at all - has no
 * twin, matches nothing, and stays. That is the whole point of the clause above
 * and it must not be undone by the one below.
 */
function notAlreadyListed(inboxIds: string[]): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1 FROM "uin_messages" o
     WHERE o."direction" = 'out'
       AND o."inbox_id" IN (${Prisma.join(inboxIds)})
       AND (o."provider_message_id" = m."message_id_header"
            OR o."message_id_header" = m."message_id_header")
  )`
}

/**
 * Whether a message is this person's own writing, for the Sent folder they open
 * under their own name.
 *
 * Two ways of being theirs, because there are two ways a message gets here.
 * One sent from this hub carries its author, so a reply written from a shared
 * address is still the person's who wrote it - which is the whole point of the
 * folder, and the half that could never be worked out from the address alone.
 *
 * One collected off a mail server carries nobody: no mailbox anywhere records
 * which colleague typed a message. That one is theirs when it went out as an
 * address that is theirs alone, which is the only honest thing that can be said
 * about it. A reply somebody wrote to a customer on their phone is their own
 * writing and belongs here; one that left a shared address with no author
 * belongs to the address rather than to a person, and is read in that address's
 * own Sent folder instead. Mail a module sent on its own - an order
 * confirmation, a campaign - has no author for the same reason and lands in the
 * same place, which is right: nobody typed it.
 */
function writtenBy(userId: string): Prisma.Sql {
  return Prisma.sql`(
    m."author_user_id" = ${userId}
    OR (m."author_user_id" IS NULL AND ${SENT_INBOX_ID} IN (
      SELECT i."id" FROM "uin_inboxes" i
       WHERE i."kind" = 'individual' AND i."owner_user_id" = ${userId}
    ))
  )`
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
  /** Whose folder this is. Null for an address's own - everything that has left
   *  it, whoever wrote it. See sentWhere. */
  ownUserId: string | null = null,
): Promise<SentMessageRow[]> {
  const where = sentWhere(inboxIds, includeUnrouted, providerModules, ownUserId)
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
  ownUserId: string | null = null,
): Promise<number> {
  const where = sentWhere(inboxIds, includeUnrouted, providerModules, ownUserId)
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
 *  a route that forgets the second half hands somebody else's writing out, and
 *  a draft id guessed in the address bar finds nothing rather than something. */
export async function getDraft(id: string, userId: string): Promise<Draft | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT d.* FROM "uin_drafts" d
     WHERE d."id" = ${id} AND ${draftScope(userId)}
     LIMIT 1
  `
  return rows[0] ? mapDraft(rows[0]) : null
}

/** Whatever THIS person left under this conversation, which the reply box opens
 *  on. One row at most - the unique index on (thread_id, author_user_id) sees
 *  to that, and it is that index which lets two colleagues each keep their own
 *  half-written answer to the same conversation without either seeing the
 *  other's. */
export async function draftForThread(threadId: string, userId: string): Promise<Draft | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT d.* FROM "uin_drafts" d
     WHERE d."thread_id" = ${threadId} AND ${draftScope(userId)}
     ORDER BY d."updated_at" DESC
     LIMIT 1
  `
  return rows[0] ? mapDraft(rows[0]) : null
}

export type DraftInput = {
  id?: string | null
  /** Whoever is saving, which on a draft that already exists is also the only
   *  person who may be: the UPDATE finds nothing under anybody else's name and
   *  the INSERT below writes a new row of their own instead. */
  authorUserId: string
  inboxId: string | null
  threadId: string | null
  mode: DraftMode
  to: string[]
  cc: string[]
  /** Copies nobody else on the message sees. Left out is an empty list, which
   *  is what every draft written before there was such a thing has. */
  bcc?: string[]
  subject: string | null
  body: string
  /** What `body` is written in. Left out is 'text', which is what every caller
   *  written before the boxes could hold a typeface means. */
  bodyFormat?: DraftBodyFormat
  attachments: DraftAttachment[]
  /** The catalogue items it carries. Left out is none, which is what every
   *  caller written before a message could carry any means. */
  products?: DraftProduct[]
  /** When it should leave on its own. A date puts it in the queue; null takes
   *  it back out and leaves an ordinary draft, which is also what clears the
   *  reason a failed one gives. LEFT OUT means leave whatever time is already
   *  on it - an ordinary Save from the composer must not quietly cancel a
   *  message somebody had set for the morning. */
  sendAt?: Date | null
  /** How long after it goes out to bring the conversation back if nobody has
   *  answered. Rides with the departure time: it is only read when `sendAt` is
   *  mentioned at all, and taking the time off takes the follow-up off with it,
   *  because a chase for a message that is not going anywhere is a conversation
   *  that comes back for no reason. */
  followUpMinutes?: number | null
  /** When the conversation should stay asleep until once this message has gone.
   *  Rides with the departure time on the same terms as the chase above: only
   *  read when `sendAt` is mentioned at all, and taking the time off takes the
   *  sleep off with it. */
  snoozeUntil?: Date | null
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
  // One decision, made once: a time means it is waiting to go, no time means it
  // is an ordinary draft, and saying nothing about it at all means leave it as
  // it was. Every other scheduling column follows from that, so a saved edit
  // never leaves a stale reason or a stale claim behind - and never cancels a
  // departure nobody asked to cancel.
  const keep = data.sendAt === undefined
  const sendAt = data.sendAt ?? null
  const sendState: DraftSendState = sendAt ? 'scheduled' : null
  // The follow-up rides with the departure time. Setting a time may set one;
  // taking the time off takes it off, because a message that is not going
  // anywhere has nothing to be chased about. And putting a time back on stands
  // the draft back up: whatever mail stood it down has been read by whoever is
  // scheduling it again.
  const followUp = sendAt ? data.followUpMinutes ?? null : null
  // The sleep rides with the departure time on exactly the same terms, and for
  // the same reason: a conversation waiting to go quiet behind a message that
  // is no longer going anywhere is a conversation that goes quiet for nothing.
  const snoozeUntil = sendAt ? data.snoozeUntil ?? null : null
  const bcc = data.bcc ?? []
  const bodyFormat = data.bodyFormat ?? 'text'
  const products = data.products ?? []
  const schedule = keep
    ? Prisma.sql`"send_at" = "send_at", "send_state" = "send_state", "send_error" = "send_error"`
    : Prisma.sql`"send_at" = ${sendAt}, "send_state" = ${sendState}, "send_error" = NULL, "claimed_at" = NULL, "follow_up_minutes" = ${followUp}, "snooze_until" = ${snoozeUntil}, "held_by_thread_id" = NULL, "held_at" = NULL`
  const scheduleOnConflict = keep
    ? Prisma.sql`"send_at" = "uin_drafts"."send_at", "send_state" = "uin_drafts"."send_state"`
    : Prisma.sql`"send_at" = EXCLUDED."send_at", "send_state" = EXCLUDED."send_state", "send_error" = NULL, "claimed_at" = NULL, "follow_up_minutes" = EXCLUDED."follow_up_minutes", "snooze_until" = EXCLUDED."snooze_until", "held_by_thread_id" = NULL, "held_at" = NULL`
  if (data.id) {
    const updated = await prisma.$queryRaw<Record<string, unknown>[]>`
      UPDATE "uin_drafts" AS d
         SET "inbox_id"     = ${data.inboxId},
             "mode"         = ${data.mode},
             "to_addresses" = ${data.to}::text[],
             "cc_addresses" = ${data.cc}::text[],
             "bcc_addresses" = ${bcc}::text[],
             "subject"      = ${data.subject},
             "body"         = ${data.body},
             "body_format"  = ${bodyFormat},
             "attachments"  = ${JSON.stringify(data.attachments)}::jsonb,
             "products"     = ${JSON.stringify(products)}::jsonb,
             ${schedule},
             "updated_at"   = now()
       WHERE d."id" = ${data.id} AND ${draftScope(data.authorUserId)}
      RETURNING *
    `
    if (updated[0]) return mapDraft(updated[0])
    // The draft was discarded, or sent, while this composer had it open. Saving
    // again writes a new one rather than throwing away what is on the screen.
  }

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    INSERT INTO "uin_drafts"
      ("author_user_id", "inbox_id", "thread_id", "mode", "to_addresses",
       "cc_addresses", "bcc_addresses", "subject", "body", "body_format", "attachments",
       "products", "send_at", "send_state", "follow_up_minutes", "snooze_until")
    VALUES (${data.authorUserId}, ${data.inboxId}, ${data.threadId}, ${data.mode},
            ${data.to}::text[], ${data.cc}::text[], ${bcc}::text[], ${data.subject},
            ${data.body}, ${bodyFormat}, ${JSON.stringify(data.attachments)}::jsonb,
            ${JSON.stringify(products)}::jsonb, ${sendAt}, ${sendState}, ${followUp},
            ${snoozeUntil})
    ON CONFLICT ("thread_id", "author_user_id") WHERE "thread_id" IS NOT NULL
    DO UPDATE SET "inbox_id"     = EXCLUDED."inbox_id",
                  "mode"         = EXCLUDED."mode",
                  "to_addresses" = EXCLUDED."to_addresses",
                  "cc_addresses" = EXCLUDED."cc_addresses",
                  "bcc_addresses" = EXCLUDED."bcc_addresses",
                  "subject"      = EXCLUDED."subject",
                  "body"         = EXCLUDED."body",
                  "body_format"  = EXCLUDED."body_format",
                  "attachments"  = EXCLUDED."attachments",
                  "products"     = EXCLUDED."products",
                  ${scheduleOnConflict},
                  "updated_at"   = now()
    RETURNING *
  `
  return mapDraft(rows[0]!)
}

/** Throws one away and hands back what was thrown - or null when there was
 *  nothing to throw, which is what a Discard pressed twice looks like, and what
 *  sending a message whose draft another tab has already tidied up looks like.
 *
 *  Returned rather than merely counted because a draft carries instructions
 *  that outlive it: a follow-up is set on the conversation AFTER the message has
 *  gone and the draft has been cleared away, and reading the row first would be
 *  a second query racing this one. */
export async function deleteDraftReturning(id: string, userId: string): Promise<Draft | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    DELETE FROM "uin_drafts" AS d
     WHERE d."id" = ${id} AND ${draftScope(userId)}
    RETURNING *
  `
  return rows[0] ? mapDraft(rows[0]) : null
}

/** The same, for the callers that only want to know whether there was one. */
export async function deleteDraft(id: string, userId: string): Promise<boolean> {
  return (await deleteDraftReturning(id, userId)) !== null
}

/** The draft behind a message that has just gone. Called by the send route
 *  with whatever the composer was carrying, so finishing a draft removes it
 *  from the list without the browser having to remember to ask. */
export async function discardDraftAfterSend(
  id: string | null | undefined,
  userId: string,
): Promise<Draft | null> {
  if (!id) return null
  try {
    // What it was is handed back: a draft may carry a follow-up, and the row is
    // the only thing that still knows the chase was asked for.
    return await deleteDraftReturning(id, userId)
  } catch (err) {
    // The message has gone. A draft left behind is untidy; a failed send
    // reported to somebody whose email actually left is a lie.
    console.error('[unified-inbox] could not tidy up the draft after sending', err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Messages written now and sent later.
//
// A scheduled message is a draft with a departure time on it (see
// migrations/021_scheduled_send.sql), so everything above already governs who
// may write one, read one and throw one away. What is left is the queue: taking
// the ones whose time has come, and putting back the ones a run took and never
// settled.
//
// The claim is a single UPDATE, and it is what stops one message going twice.
// Two runs overlapping - the scheduled tick and somebody pressing Check now -
// both look for due rows, and only one of them can move a row out of
// 'scheduled'. SKIP LOCKED means the loser walks past the row rather than
// waiting behind it holding a lock for the length of a mail send.
// ---------------------------------------------------------------------------

/**
 * Takes the timer off a message somebody has decided to send by hand after all.
 *
 * The one thing standing between "Send now" on a message already waiting for
 * its own moment and the SAME message going out twice. The queue claims a row
 * by moving it out of 'scheduled' and only posts what it claimed, so clearing
 * the state here - in one statement, refusing to touch a row a run already has
 * - means exactly one of the two sends it. The composer's idempotency key is no
 * help: it is that composer's own, and the queue's is derived from the draft's
 * id, so two keys would happily post two messages.
 *
 * 'in-flight' is the one answer worth refusing on. A draft that is not there at
 * all answers 'ready', because that is what pressing Send twice looks like and
 * the send itself already copes with it.
 */
export async function standDownScheduledDraft(
  id: string,
  userId: string,
): Promise<'ready' | 'in-flight'> {
  const cleared = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "uin_drafts" AS d
       SET "send_at"    = NULL,
           "send_state" = NULL,
           "send_error" = NULL,
           "claimed_at" = NULL
     WHERE d."id" = ${id} AND ${draftScope(userId)}
       AND d."send_state" IS DISTINCT FROM 'sending'
    RETURNING d."id" AS "id"
  `
  if (cleared.length > 0) return 'ready'
  // Nothing moved, which is either a draft that is not this person's to send -
  // and the send route's own checks answer that - or a run holding it right
  // now, which is the case somebody has to be told about.
  const found = await prisma.$queryRaw<{ send_state: string | null }[]>`
    SELECT d."send_state" AS "send_state" FROM "uin_drafts" d
     WHERE d."id" = ${id} AND ${draftScope(userId)}
     LIMIT 1
  `
  return found[0]?.send_state === 'sending' ? 'in-flight' : 'ready'
}

/** Takes the messages whose time has come, marking them as being sent in the
 *  same statement that finds them. Whatever comes back is this run's and
 *  nobody else's. */
export async function claimDueScheduledDrafts(now: Date, limit: number): Promise<Draft[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    UPDATE "uin_drafts"
       SET "send_state" = 'sending',
           "claimed_at" = now()
     WHERE "id" IN (
       SELECT "id" FROM "uin_drafts"
        WHERE "send_state" = 'scheduled' AND "send_at" <= ${now}
        ORDER BY "send_at" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING *
  `
  return rows.map(mapDraft)
}

/** Its time came and the mail server said no. The writing stays exactly where
 *  it is, with the reason beside it, because the alternative is a message
 *  nobody sent and nobody can find. */
export async function failScheduledDraft(id: string, reason: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "uin_drafts"
       SET "send_state" = 'failed',
           "send_error" = ${reason},
           "claimed_at" = NULL,
           "updated_at" = now()
     WHERE "id" = ${id} AND "send_state" = 'sending'
  `
}

/** Claims from a run that died between taking a message and settling it. Put
 *  back rather than failed: nothing was sent, so there is nothing to explain,
 *  and the next run picks it up as it would have done. Returns how many. */
export async function releaseStaleScheduledClaims(before: Date): Promise<number> {
  return await prisma.$executeRaw`
    UPDATE "uin_drafts"
       SET "send_state" = 'scheduled',
           "claimed_at" = NULL
     WHERE "send_state" = 'sending'
       AND ("claimed_at" IS NULL OR "claimed_at" < ${before})
  `
}

// ---------------------------------------------------------------------------
// Standing a scheduled message down, because they wrote first.
//
// A message set for Monday morning was written without Monday's post in front
// of it. If the person it is addressed to writes to us before it leaves,
// sending it anyway asks a question that has already been answered - so the
// departure time comes off and the writing stays exactly where it is, for
// somebody to read alongside what has just arrived and send, rewrite or throw
// away themselves.
//
// It is deliberately NOT a fourth send_state. What is left is an ordinary
// draft, which everything in this module already understands; the two held
// columns are the note explaining why it stopped being scheduled, and the note
// is what the conversation screen shows.
//
// Only ever 'scheduled' rows. A message already claimed by a run that is
// posting it right now is gone - the mail server may already have it - and
// pretending it was held would be the module telling somebody a message it had
// sent was still here.
// ---------------------------------------------------------------------------

/** Stands down every scheduled message addressed to this person, and says
 *  which. Matched without regard to case, because a mail server does not care
 *  and neither does anybody typing an address into the To line. Only the To
 *  line: it is who the message is FOR, and standing a departure down is too
 *  strong a thing to do on the strength of a Cc.
 *
 *  The state goes, so nothing collects it; the TIME STAYS, so the screen can
 *  say what it was going to do rather than only that it is not doing it. A time
 *  with no state on it is an ordinary draft to every other query in this file,
 *  which is exactly what a stood-down message is. */
export async function holdScheduledDraftsFor(address: string, threadId: string): Promise<Draft[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    UPDATE "uin_drafts" d
       SET "send_state"        = NULL,
           "send_error"        = NULL,
           "claimed_at"        = NULL,
           "held_by_thread_id" = ${threadId},
           "held_at"           = now(),
           "updated_at"        = now()
     WHERE d."send_state" = 'scheduled'
       AND EXISTS (
         SELECT 1 FROM unnest(d."to_addresses") AS "recipient"
          WHERE lower("recipient") = lower(${address})
       )
    RETURNING *
  `
  return rows.map(mapDraft)
}

/** What of this person's own is being held because of this conversation. The
 *  same rule as every other way of reaching a draft (E17): a colleague's held
 *  message is never fetched, so the warning is not a way of learning that they
 *  had one waiting. */
export async function draftsHeldByThread(threadId: string, userId: string): Promise<Draft[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT d.* FROM "uin_drafts" d
     WHERE d."held_by_thread_id" = ${threadId} AND ${draftScope(userId)}
     ORDER BY d."held_at" DESC
     LIMIT 20
  `
  return rows.map(mapDraft)
}

/** Puts back the exact rows this run claimed and then ran out of clock for.
 *  By id rather than by age, because a run that reached its deadline must not
 *  disturb a claim another run is still working through. */
export async function releaseScheduledClaims(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  return await prisma.$executeRaw`
    UPDATE "uin_drafts"
       SET "send_state" = 'scheduled',
           "claimed_at" = NULL
     WHERE "send_state" = 'sending' AND "id" IN (${Prisma.join(ids)})
  `
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
    firstName: (r.first_name as string | null) ?? null,
    lastName: (r.last_name as string | null) ?? null,
    jobTitle: (r.job_title as string | null) ?? null,
    website: (r.website as string | null) ?? null,
    primaryEmail: (r.primary_email as string | null) ?? null,
    organisationId: (r.organisation_id as string | null) ?? null,
    organisationName: (r.organisation_name as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    origin: ((r.origin as string | null) ?? 'mail') as ContactOrigin,
    addressLine1: (r.address_line1 as string | null) ?? null,
    addressLine2: (r.address_line2 as string | null) ?? null,
    addressCity: (r.address_city as string | null) ?? null,
    addressCounty: (r.address_county as string | null) ?? null,
    addressPostcode: (r.address_postcode as string | null) ?? null,
    addressCountry: (r.address_country as string | null) ?? null,
    mergedIntoId: (r.merged_into_id as string | null) ?? null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  }
}

const PERSON_SELECT = Prisma.sql`
  p."id", p."display_name", p."first_name", p."last_name", p."job_title", p."website",
  p."primary_email", p."organisation_id", p."notes", p."origin",
  p."address_line1", p."address_line2", p."address_city", p."address_county",
  p."address_postcode", p."address_country",
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

export type PersonListRow = Person & {
  identityCount: number
  threadCount: number
  /** The first number on record, for the contacts list. Numbers live in the
   *  identities table rather than on the person (see 025_contacts.sql), so a
   *  list that wants to show one has to go and get it. */
  phone: string | null
}

/** How the contacts list is ordered. By surname is what an address book does;
 *  by when we last heard from them is what an inbox does, and both screens read
 *  this one query. */
export type PeopleSort = 'name' | 'recent'

/** The people directory: everybody we have met, minus anybody who lost a merge.
 *
 *  Ordering by name puts the ones with no surname last rather than first. A
 *  contacts list that opens on twenty blanks looks broken, and the ones with no
 *  name yet are exactly the ones somebody is least likely to be looking for. */
export async function listPeople(opts: {
  search?: string | null
  page: number
  perPage: number
  sort?: PeopleSort
  organisationId?: string | null
  /** Only the contacts wearing this label. */
  categoryId?: string | null
}): Promise<{ rows: PersonListRow[]; total: number }> {
  const term = opts.search?.trim()
  const clauses: Prisma.Sql[] = [Prisma.sql`p."merged_into_id" IS NULL`]
  if (term) {
    clauses.push(Prisma.sql`(
        p."display_name" ILIKE ${`%${term}%`}
        OR p."first_name" ILIKE ${`%${term}%`}
        OR p."last_name" ILIKE ${`%${term}%`}
        OR p."primary_email" ILIKE ${`%${term}%`}
        OR p."job_title" ILIKE ${`%${term}%`}
        OR p."address_postcode" ILIKE ${`%${term}%`}
        OR p."address_city" ILIKE ${`%${term}%`}
        OR o."name" ILIKE ${`%${term}%`}
        OR EXISTS (SELECT 1 FROM "uin_person_identities" i
                    WHERE i."person_id" = p."id" AND i."value" ILIKE ${`%${term}%`}))`)
  }
  if (opts.organisationId) clauses.push(Prisma.sql`p."organisation_id" = ${opts.organisationId}`)
  if (opts.categoryId) {
    clauses.push(Prisma.sql`EXISTS (SELECT 1 FROM "uin_person_categories" pc
                                     WHERE pc."person_id" = p."id"
                                       AND pc."category_id" = ${opts.categoryId})`)
  }
  const where = Prisma.join(clauses, ' AND ')

  const order = opts.sort === 'name'
    ? Prisma.sql`p."last_name" ASC NULLS LAST, p."first_name" ASC NULLS LAST, p."display_name" ASC NULLS LAST`
    : Prisma.sql`p."updated_at" DESC`

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT ${PERSON_SELECT},
           (SELECT COUNT(*) FROM "uin_person_identities" i WHERE i."person_id" = p."id") AS identity_count,
           (SELECT COUNT(*) FROM "uin_threads" t
             WHERE t."person_id" = p."id" AND t."merged_into_id" IS NULL) AS thread_count,
           (SELECT i."value" FROM "uin_person_identities" i
             WHERE i."person_id" = p."id" AND i."kind" = 'phone'
             ORDER BY i."created_at" ASC LIMIT 1) AS phone
      FROM "uin_people" p
      LEFT JOIN "uin_organisations" o ON o."id" = p."organisation_id"
     WHERE ${where}
     ORDER BY ${order}
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
      phone: (r.phone as string | null) ?? null,
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

/** Everything an address book card holds beyond the name, all of it optional.
 *  `undefined` means "leave it as it was" and `null` means "clear it", which is
 *  the difference between a form that saved two fields and a form that wiped
 *  the other eleven. */
export type PersonDetails = Partial<PostalAddress> & {
  firstName?: string | null
  lastName?: string | null
  jobTitle?: string | null
  website?: string | null
}

/** The columns a person's own details live in, written once and used by both
 *  the insert and the update - a field added to one and forgotten in the other
 *  is a field that saves on the edit form and vanishes on the new one. */
const PERSON_DETAIL_COLUMNS: ReadonlyArray<[keyof PersonDetails, string]> = [
  ['firstName', 'first_name'],
  ['lastName', 'last_name'],
  ['jobTitle', 'job_title'],
  ['website', 'website'],
  ['addressLine1', 'address_line1'],
  ['addressLine2', 'address_line2'],
  ['addressCity', 'address_city'],
  ['addressCounty', 'address_county'],
  ['addressPostcode', 'address_postcode'],
  ['addressCountry', 'address_country'],
]

export async function createPerson(data: {
  displayName: string | null
  primaryEmail: string | null
  organisationId: string | null
  notes?: string | null
  origin?: ContactOrigin
  details?: PersonDetails
}): Promise<string> {
  const columns: Prisma.Sql[] = [
    Prisma.sql`"display_name"`, Prisma.sql`"primary_email"`,
    Prisma.sql`"organisation_id"`, Prisma.sql`"notes"`, Prisma.sql`"origin"`,
  ]
  const values: Prisma.Sql[] = [
    Prisma.sql`${data.displayName}`, Prisma.sql`${data.primaryEmail}`,
    Prisma.sql`${data.organisationId}`, Prisma.sql`${data.notes ?? null}`,
    Prisma.sql`${data.origin ?? 'mail'}`,
  ]
  for (const [key, column] of PERSON_DETAIL_COLUMNS) {
    const value = data.details?.[key]
    if (value === undefined) continue
    columns.push(Prisma.raw(`"${column}"`))
    values.push(Prisma.sql`${value}`)
  }
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "uin_people" (${Prisma.join(columns, ', ')})
    VALUES (${Prisma.join(values, ', ')})
    RETURNING "id"
  `
  return rows[0]!.id
}

export async function updatePerson(id: string, data: PersonDetails & {
  displayName?: string | null
  primaryEmail?: string | null
  organisationId?: string | null
  notes?: string | null
  origin?: ContactOrigin
}): Promise<void> {
  const sets: Prisma.Sql[] = []
  if (data.displayName !== undefined) sets.push(Prisma.sql`"display_name" = ${data.displayName}`)
  if (data.primaryEmail !== undefined) sets.push(Prisma.sql`"primary_email" = ${data.primaryEmail}`)
  if (data.organisationId !== undefined) sets.push(Prisma.sql`"organisation_id" = ${data.organisationId}`)
  if (data.notes !== undefined) sets.push(Prisma.sql`"notes" = ${data.notes}`)
  if (data.origin !== undefined) sets.push(Prisma.sql`"origin" = ${data.origin}`)
  for (const [key, column] of PERSON_DETAIL_COLUMNS) {
    const value = data[key]
    if (value === undefined) continue
    sets.push(Prisma.sql`${Prisma.raw(`"${column}"`)} = ${value}`)
  }
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
}): Promise<boolean> {
  const written = await prisma.$executeRaw`
    INSERT INTO "uin_person_identities" ("person_id", "kind", "value", "match_value", "source")
    VALUES (${data.personId}, ${data.kind}, ${data.value}, ${data.matchValue}, ${data.source})
    ON CONFLICT ("value") DO NOTHING
  `
  // Whether the row went in, which is what the contacts screen needs to tell
  // "saved" apart from "somebody else already holds that address" - the one
  // case where nothing happening is the correct behaviour and a silent one.
  return written > 0
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

/** The same, said with the person as well.
 *
 *  Which is the point: an identity id typed into the address bar must not take
 *  a way of reaching somebody else off them, so the person is part of the WHERE
 *  rather than something checked first and trusted after. Returns whether a row
 *  actually went. */
export async function deleteIdentityForPerson(personId: string, id: string): Promise<boolean> {
  const removed = await prisma.$executeRaw`
    DELETE FROM "uin_person_identities" WHERE "id" = ${id} AND "person_id" = ${personId}
  `
  return removed > 0
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

function mapOrganisation(r: Record<string, unknown>): Organisation {
  return {
    id: r.id as string,
    name: r.name as string,
    domain: (r.domain as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    website: (r.website as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    origin: ((r.origin as string | null) ?? 'mail') as ContactOrigin,
    addressLine1: (r.address_line1 as string | null) ?? null,
    addressLine2: (r.address_line2 as string | null) ?? null,
    addressCity: (r.address_city as string | null) ?? null,
    addressCounty: (r.address_county as string | null) ?? null,
    addressPostcode: (r.address_postcode as string | null) ?? null,
    addressCountry: (r.address_country as string | null) ?? null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  }
}

export async function getOrganisation(id: string): Promise<Organisation | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_organisations" WHERE "id" = ${id}
  `
  return rows[0] ? mapOrganisation(rows[0]) : null
}

export type OrganisationListRow = Organisation & { peopleCount: number }

/** The organisations directory, by name, with how many contacts each one has.
 *  The count is what makes "Acme Ltd" and "Acme Limited" - the two an import
 *  can leave behind - visible enough to be merged by hand. */
export async function listOrganisations(opts: {
  search?: string | null
  page: number
  perPage: number
}): Promise<{ rows: OrganisationListRow[]; total: number }> {
  const term = opts.search?.trim()
  const where = term
    ? Prisma.sql`(g."name" ILIKE ${`%${term}%`} OR g."domain" ILIKE ${`%${term}%`}
                  OR g."address_postcode" ILIKE ${`%${term}%`} OR g."address_city" ILIKE ${`%${term}%`})`
    : Prisma.sql`TRUE`

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT g.*,
           (SELECT COUNT(*) FROM "uin_people" p
             WHERE p."organisation_id" = g."id" AND p."merged_into_id" IS NULL) AS people_count
      FROM "uin_organisations" g
     WHERE ${where}
     ORDER BY g."name" ASC
     LIMIT ${opts.perPage} OFFSET ${(opts.page - 1) * opts.perPage}
  `
  const counted = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "uin_organisations" g WHERE ${where}
  `
  return {
    rows: rows.map((r) => ({ ...mapOrganisation(r), peopleCount: Number(r.people_count ?? 0) })),
    total: Number(counted[0]?.count ?? 0),
  }
}

/** An organisation by name, case and surrounding space ignored.
 *
 *  What an import matches on. A sheet says "Acme Ltd" in two thousand rows and
 *  means one company, and creating two thousand of them - or one per spelling
 *  of the same name - is the failure mode of every contacts import there has
 *  ever been. Merged-away people have no bearing here; organisations do not
 *  merge. */
export async function findOrganisationByName(name: string): Promise<Organisation | null> {
  const clean = name.trim()
  if (!clean) return null
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_organisations" WHERE lower(btrim("name")) = ${clean.toLowerCase()} LIMIT 1
  `
  return rows[0] ? mapOrganisation(rows[0]) : null
}

/** The columns an organisation's own details live in. Same reasoning as the
 *  person's list above: one place, so the insert and the update cannot drift. */
const ORGANISATION_DETAIL_COLUMNS: ReadonlyArray<[keyof OrganisationDetails, string]> = [
  ['domain', 'domain'],
  ['email', 'email'],
  ['phone', 'phone'],
  ['website', 'website'],
  ['notes', 'notes'],
  ['addressLine1', 'address_line1'],
  ['addressLine2', 'address_line2'],
  ['addressCity', 'address_city'],
  ['addressCounty', 'address_county'],
  ['addressPostcode', 'address_postcode'],
  ['addressCountry', 'address_country'],
]

export type OrganisationDetails = Partial<PostalAddress> & {
  domain?: string | null
  email?: string | null
  phone?: string | null
  website?: string | null
  notes?: string | null
}

export async function createOrganisation(data: OrganisationDetails & {
  name: string
  origin?: ContactOrigin
}): Promise<string> {
  const columns: Prisma.Sql[] = [Prisma.sql`"name"`, Prisma.sql`"origin"`]
  const values: Prisma.Sql[] = [Prisma.sql`${data.name}`, Prisma.sql`${data.origin ?? 'hand'}`]
  for (const [key, column] of ORGANISATION_DETAIL_COLUMNS) {
    const value = data[key]
    if (value === undefined) continue
    columns.push(Prisma.raw(`"${column}"`))
    values.push(Prisma.sql`${value}`)
  }
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "uin_organisations" (${Prisma.join(columns, ', ')})
    VALUES (${Prisma.join(values, ', ')})
    RETURNING "id"
  `
  return rows[0]!.id
}

export async function updateOrganisation(id: string, data: OrganisationDetails & {
  name?: string
}): Promise<void> {
  const sets: Prisma.Sql[] = []
  if (data.name !== undefined) sets.push(Prisma.sql`"name" = ${data.name}`)
  for (const [key, column] of ORGANISATION_DETAIL_COLUMNS) {
    const value = data[key]
    if (value === undefined) continue
    sets.push(Prisma.sql`${Prisma.raw(`"${column}"`)} = ${value}`)
  }
  if (sets.length === 0) return
  await prisma.$executeRaw`
    UPDATE "uin_organisations" SET ${Prisma.join(sets, ', ')}, "updated_at" = now()
     WHERE "id" = ${id}
  `
}

/** Removing an organisation. Everybody who was in it keeps their record and
 *  loses the badge, which the foreign key does on its own - a contact is not
 *  the company they work for, and deleting a supplier must not delete the
 *  person who answers the phone there. */
export async function deleteOrganisation(id: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "uin_organisations" WHERE "id" = ${id}`
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
// Categories: the label somebody puts on a contact.
//
// A company is not a category - a supplier and a customer can both be at Acme
// Ltd, and the haulier who only telephones has no company here at all - so this
// is its own small list with its own join table.
//
// Matched on the name however it was typed, which is the whole reason the
// unique index in 026 is on lower(btrim(name)): a file with "Supplier" on one
// row and "supplier" on the next means one category, and two would be a mess
// somebody unpicks by hand.
// ---------------------------------------------------------------------------

function mapCategory(r: Record<string, unknown>): ContactCategory {
  return {
    id: r.id as string,
    name: r.name as string,
    sortOrder: Number(r.sort_order ?? 0),
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  }
}

export type CategoryListRow = ContactCategory & { peopleCount: number }

/** Every category, in the order somebody put them in, with how many contacts
 *  are in each - which is what makes an empty one worth deleting and a typo
 *  worth renaming. */
export async function listCategories(): Promise<CategoryListRow[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT c.*,
           (SELECT COUNT(*) FROM "uin_person_categories" pc
              JOIN "uin_people" p ON p."id" = pc."person_id"
             WHERE pc."category_id" = c."id" AND p."merged_into_id" IS NULL) AS people_count
      FROM "uin_contact_categories" c
     ORDER BY c."sort_order" ASC, c."name" ASC
  `
  return rows.map((r) => ({ ...mapCategory(r), peopleCount: Number(r.people_count ?? 0) }))
}

export async function getCategory(id: string): Promise<ContactCategory | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_contact_categories" WHERE "id" = ${id}
  `
  return rows[0] ? mapCategory(rows[0]) : null
}

export async function findCategoryByName(name: string): Promise<ContactCategory | null> {
  const clean = name.trim()
  if (!clean) return null
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_contact_categories"
     WHERE lower(btrim("name")) = ${clean.toLowerCase()} LIMIT 1
  `
  return rows[0] ? mapCategory(rows[0]) : null
}

/**
 * A category by that name, made if there is not one.
 *
 * `ON CONFLICT` names no column because the constraint is an expression index -
 * Postgres will not take `("name")` for a unique index on `lower(btrim("name"))`
 * - so the conflict is declared the same way the index is. Without it, two
 * imports running at once would raise rather than settle.
 */
export async function findOrCreateCategory(name: string): Promise<string> {
  const clean = name.trim()
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "uin_contact_categories" ("name") VALUES (${clean})
    ON CONFLICT (lower(btrim("name"))) DO UPDATE SET "updated_at" = now()
    RETURNING "id"
  `
  return rows[0]!.id
}

export async function createCategory(name: string): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "uin_contact_categories" ("name", "sort_order")
    VALUES (
      ${name.trim()},
      (SELECT COALESCE(MAX("sort_order"), -1) + 1 FROM "uin_contact_categories")
    )
    RETURNING "id"
  `
  return rows[0]!.id
}

export async function renameCategory(id: string, name: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "uin_contact_categories"
       SET "name" = ${name.trim()}, "updated_at" = now()
     WHERE "id" = ${id}
  `
}

/** Removing a category. Everybody in it keeps their record and loses the label,
 *  which the join table's ON DELETE CASCADE does on its own - a category is
 *  something somebody said ABOUT a contact, never the contact. */
export async function deleteCategory(id: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "uin_contact_categories" WHERE "id" = ${id}`
}

/** The order somebody dragged them into. Ids not in the list are left where
 *  they are, so a category added while the screen was open is not shuffled to
 *  the front by somebody else's save. */
export async function reorderCategories(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  for (const [index, id] of ids.entries()) {
    await prisma.$executeRaw`
      UPDATE "uin_contact_categories" SET "sort_order" = ${index}, "updated_at" = now()
       WHERE "id" = ${id}
    `
  }
}

/** One contact's categories, in the list's own order. */
export async function categoriesForPerson(personId: string): Promise<ContactCategory[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT c.* FROM "uin_contact_categories" c
      JOIN "uin_person_categories" pc ON pc."category_id" = c."id"
     WHERE pc."person_id" = ${personId}
     ORDER BY c."sort_order" ASC, c."name" ASC
  `
  return rows.map(mapCategory)
}

/**
 * The categories on a whole page of contacts, in one query.
 *
 * The list draws twenty-five rows and every one of them wants its labels. A
 * query per row is twenty-five round trips for a screen somebody scrolls past.
 */
export async function categoriesForPeople(
  personIds: string[],
): Promise<Record<string, string[]>> {
  if (personIds.length === 0) return {}
  const rows = await prisma.$queryRaw<{ person_id: string; name: string }[]>`
    SELECT pc."person_id", c."name"
      FROM "uin_person_categories" pc
      JOIN "uin_contact_categories" c ON c."id" = pc."category_id"
     WHERE pc."person_id" IN (${Prisma.join(personIds)})
     ORDER BY c."sort_order" ASC, c."name" ASC
  `
  const byPerson: Record<string, string[]> = {}
  for (const row of rows) {
    const list = byPerson[row.person_id]
    if (list) list.push(row.name)
    else byPerson[row.person_id] = [row.name]
  }
  return byPerson
}

/**
 * Which categories one contact is in, set outright.
 *
 * A replace rather than a merge, because that is what a card full of ticks
 * means: what is ticked is what they are in. The delete names the ids that are
 * staying rather than clearing the lot and writing them back, so a category
 * somebody was already in keeps the date it was put on.
 */
export async function setPersonCategories(personId: string, categoryIds: string[]): Promise<void> {
  if (categoryIds.length === 0) {
    await prisma.$executeRaw`DELETE FROM "uin_person_categories" WHERE "person_id" = ${personId}`
    return
  }
  await prisma.$executeRaw`
    DELETE FROM "uin_person_categories"
     WHERE "person_id" = ${personId}
       AND "category_id" NOT IN (${Prisma.join(categoryIds)})
  `
  for (const categoryId of categoryIds) {
    await prisma.$executeRaw`
      INSERT INTO "uin_person_categories" ("person_id", "category_id")
      VALUES (${personId}, ${categoryId})
      ON CONFLICT ("person_id", "category_id") DO NOTHING
    `
  }
}

/** Put a contact in some categories without taking them out of any. What an
 *  import does: a file that says "Supplier" is adding a fact, not stating the
 *  whole of what somebody is. */
export async function addPersonCategories(personId: string, categoryIds: string[]): Promise<void> {
  for (const categoryId of categoryIds) {
    await prisma.$executeRaw`
      INSERT INTO "uin_person_categories" ("person_id", "category_id")
      VALUES (${personId}, ${categoryId})
      ON CONFLICT ("person_id", "category_id") DO NOTHING
    `
  }
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
     WHERE "person_id" IS NULL AND "provider_module" IS NULL AND "merged_into_id" IS NULL
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

/**
 * How many conversations this person has at all, whoever may read them.
 *
 * Asked so that a contact with no conversations is not mistaken for one whose
 * conversations this reader may not see. The two used to be the same answer,
 * which was right when the only way to become a person was to write in - and
 * became wrong the moment somebody could be added by hand, because a contact
 * typed in this morning has no mail against them and was being hidden from
 * everybody but an administrator.
 */
export async function countThreadsForPerson(personId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "uin_threads"
     WHERE "person_id" = ${personId} AND "merged_into_id" IS NULL
  `
  return Number(rows[0]?.count ?? 0)
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

/**
 * Every email address that has appeared on a conversation - who wrote, who it
 * was written to, and who was copied in.
 *
 * Read off the messages rather than off the person the conversation is matched
 * to, because they are not the same list and the difference is the whole point:
 * a conversation is matched to ONE person, and the supplier who answered from
 * the shared sales@ address, the colleague who was copied in and the customer
 * who started it are all on it. What comes back is exactly as written; deciding
 * which of them are ours rather than theirs belongs to the gate in lib/people.ts
 * and is done by the caller.
 *
 * Capped, because a long forwarded chain can carry a hundred addresses and the
 * only use for this is ranking a short list. Newest first, so the cap keeps the
 * people still talking rather than the ones who dropped out in March.
 */
export async function addressesOnThread(threadId: string, limit = 200): Promise<string[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "from_address", "to_addresses", "cc_addresses"
      FROM "uin_messages"
     WHERE "thread_id" = ${threadId}
     ORDER BY COALESCE("sent_at", "created_at") DESC
     LIMIT ${limit}
  `
  const out: string[] = []
  for (const row of rows) {
    const from = row.from_address as string | null
    if (from) out.push(from)
    for (const key of ['to_addresses', 'cc_addresses'] as const) {
      const list = row[key] as string[] | null
      if (Array.isArray(list)) out.push(...list.filter((a): a is string => typeof a === 'string'))
    }
  }
  return [...new Set(out)]
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
     WHERE "merged_into_id" IS NULL
       AND ("linked_at" IS NULL
            OR ("last_message_at" IS NOT NULL AND "linked_at" < "last_message_at"))
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
  /** The inbox the channel addressed this at, already checked to be one of
   *  ours, or null for a conversation that was addressed at nothing. Only ever
   *  set when the conversation is FIRST filed - see below. */
  inboxId: string | null
  /** What on the site it came from, in the channel's own words. */
  sourceLabel: string | null
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
       "preview", "last_message_at", "last_direction", "unread", "message_count",
       "inbox_id", "source_label")
    VALUES (${data.providerModule}, ${data.externalId}, ${data.channel}, ${data.subject},
            ${data.subjectNormalised}, ${data.preview}, ${data.lastMessageAt},
            ${data.lastDirection}, ${data.unread}, 0,
            ${data.inboxId}, ${data.sourceLabel})
    ON CONFLICT ("provider_module", "external_id")
      WHERE "provider_module" IS NOT NULL AND "external_id" IS NOT NULL
      DO UPDATE SET
        "subject"            = EXCLUDED."subject",
        "subject_normalised" = EXCLUDED."subject_normalised",
        "preview"            = EXCLUDED."preview",
        -- Filed once and then left alone. Where a conversation lives is this
        -- hub's own bookkeeping the moment it has arrived: somebody who moved
        -- an enquiry out of sales@ this morning must not find it back there
        -- after the next collection because the form still says sales@.
        -- COALESCE rather than a plain skip so a conversation collected before
        -- its form was pointed anywhere is filed the first time it is.
        "inbox_id"           = COALESCE("uin_threads"."inbox_id", EXCLUDED."inbox_id"),
        -- What it came from does not change, but a channel that only started
        -- reporting it in an update should be believed rather than ignored.
        "source_label"       = COALESCE(EXCLUDED."source_label", "uin_threads"."source_label"),
        "last_message_at"    = GREATEST(
                                 COALESCE("uin_threads"."last_message_at", EXCLUDED."last_message_at"),
                                 EXCLUDED."last_message_at"),
        "last_direction"     = EXCLUDED."last_direction",
        -- Unread only ever goes ON from out here, and only when the
        -- conversation has actually moved on. A conversation somebody has
        -- opened in this hub stays read even while the far end still counts it
        -- as new, because the person who read it is the one sitting here.
        --
        -- The second half of that is the one that was missing. A channel with
        -- no read state of its own - the contact form is the plain case -
        -- reports every enquiry as new for ever, so a re-listing with nothing
        -- new in it was marking read enquiries unread again on every
        -- collection. The hub does tell the channel now (see
        -- lib/provider-read.ts), but a channel that cannot be told, or that
        -- would not listen, must not be able to do this either. A genuinely
        -- newer message raises it, which is what unread is for.
        "unread"             = "uin_threads"."unread"
                               OR (EXCLUDED."unread" AND (
                                    "uin_threads"."last_message_at" IS NULL
                                    OR EXCLUDED."last_message_at" > "uin_threads"."last_message_at"
                                  )),
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
     WHERE "provider_module" IS NOT NULL AND "merged_into_id" IS NULL
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
  // Follows a merge. The module's own id for a conversation stays on the side
  // that lost one - it is that side's identity, and the winner has its own - so
  // reading the row straight would hand the next chat message to a conversation
  // no list shows, and the customer's reply would simply never appear. One hop
  // is enough: merging into something already merged is refused, and a merge
  // re-points every pointer aimed at what it just absorbed.
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT CASE WHEN w."id" IS NULL THEN t."id"            ELSE w."id" END            AS "id",
           CASE WHEN w."id" IS NULL THEN t."last_message_at" ELSE w."last_message_at" END AS "last_message_at",
           CASE WHEN w."id" IS NULL THEN t."message_count"   ELSE w."message_count"   END AS "message_count"
      FROM "uin_threads" t
      LEFT JOIN "uin_threads" w ON w."id" = t."merged_into_id"
     WHERE t."provider_module" = ${providerModule} AND t."external_id" = ${externalId}
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
     WHERE "person_id" IS NULL AND "provider_module" IS NOT NULL AND "merged_into_id" IS NULL
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
  const where: Prisma.Sql[] = [
    Prisma.sql`t."last_message_at" < ${cutoff}`,
    // Never chosen on its own. A conversation that lost a merge is deleted with
    // the one it was merged into, by deleteThreads, so that the pointer holding
    // it out of sight can never be cleared while it still has a thread to point
    // at (see migrations/031_thread_merges.sql).
    Prisma.sql`t."merged_into_id" IS NULL`,
  ]
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
     WHERE t."last_message_at" < ${cutoff} AND t."merged_into_id" IS NULL
  `
  return { due: Number(rows[0]?.due ?? 0), linked: Number(rows[0]?.linked ?? 0) }
}

/** A stored object this module owns, so the sweep can take the bytes out of
 *  storage before it takes the row out of the database. */
export type StoredObjectRef = { attachmentId: string; mediaKey: string; mediaProvider: string }

export async function storedObjectsForThreads(threadIds: string[]): Promise<StoredObjectRef[]> {
  if (threadIds.length === 0) return []
  // `merged_from_thread_id` as well as `thread_id`, or a merge would quietly
  // exempt somebody's attachments from their own erasure: a message a merge
  // moved onto another conversation is no longer ON one of these threads, and
  // the bytes behind it would sit in storage for ever.
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT a."id", a."media_key", a."media_provider"
      FROM "uin_attachments" a
      JOIN "uin_messages" m ON m."id" = a."message_id"
     WHERE (m."thread_id" IN (${Prisma.join(threadIds)})
            OR m."merged_from_thread_id" IN (${Prisma.join(threadIds)}))
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

  // Messages a merge moved off these conversations onto another one. They are
  // still these conversations' messages - moving them was a filing decision,
  // not a change of ownership - so a sweep or an erasure that took the thread
  // and left them behind would leave the words sitting on somebody else's
  // conversation, readable, after the conversation they belong to had gone.
  await prisma.$executeRaw`
    DELETE FROM "uin_messages" WHERE "merged_from_thread_id" IN (${Prisma.join(threadIds)})
  `

  // Anything merged INTO one of these goes with it. The losing side is kept
  // only so the merge can be put back, and putting a merge back into a
  // conversation that has since been deleted is not a thing that can happen -
  // but leaving it would be far worse than useless: `merged_into_id` is ON
  // DELETE SET NULL, so an orphaned loser would stop being merged away and
  // reappear in every list as a conversation holding nothing but duplicates.
  await prisma.$executeRaw`
    DELETE FROM "uin_threads" WHERE "merged_into_id" IN (${Prisma.join(threadIds)})
  `

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
  /** Campaign rows held about them - one per campaign they were on. These DO
   *  go: they hold a name, an address and a company, which is exactly the sort
   *  of thing being asked about. */
  campaignRows: number
}

export async function personErasePreview(personId: string): Promise<PersonErasePreview | null> {
  const person = await getPerson(personId)
  if (!person) return null

  const identities = await listIdentities(personId)
  const emails = identities.filter((i) => i.kind === 'email').map((i) => i.value.toLowerCase())

  const [counts] = await prisma.$queryRaw<Array<{ conversations: bigint; messages: bigint; attachments: bigint; stored: bigint }>>`
    -- Conversations as the person's own page counts them, so the confirmation
    -- and the screen behind it agree: a conversation that lost a merge is part
    -- of one that is still listed, not a second one. Its messages and its
    -- attachments still count - they go too.
    SELECT COUNT(DISTINCT t."id") FILTER (WHERE t."merged_into_id" IS NULL)::bigint AS "conversations",
           COUNT(DISTINCT m."id")::bigint AS "messages",
           COUNT(DISTINCT a."id")::bigint AS "attachments",
           COUNT(DISTINCT a."id") FILTER (WHERE a."media_key" IS NOT NULL)::bigint AS "stored"
      FROM "uin_threads" t
      LEFT JOIN "uin_messages" m
             ON m."thread_id" = t."id" OR m."merged_from_thread_id" = t."id"
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

  // Campaign rows go with them by foreign key when the person row is removed.
  // Counted here so the confirmation can say so rather than leaving somebody to
  // wonder whether a mailshot list still has their name on it.
  const [campaigns] = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
      FROM "uin_campaign_recipients"
     WHERE "person_id" = ${personId}
  `

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
    campaignRows: Number(campaigns?.count ?? 0),
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
  // A message a merge moved off one of these conversations is reported under
  // the conversation it came FROM, which is the one being exported. Otherwise a
  // person's own export would be missing everything they said before somebody
  // tidied two threads into one, and an export with a hole in it is worse than
  // no export: it looks complete.
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT m."id",
           CASE WHEN m."merged_from_thread_id" IN (${Prisma.join(threadIds)})
                THEN m."merged_from_thread_id" ELSE m."thread_id" END AS "thread_id",
           m."direction", m."channel", m."subject",
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
        OR m."merged_from_thread_id" IN (${Prisma.join(threadIds)})
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

/**
 * The key on the campaign tick address, made the first time it is asked for.
 *
 * Same arrangement as the Brevo webhook secret above: a long random value that
 * lives in the address itself, because the free minute-by-minute pingers a site
 * would point at this cannot set a header. Regenerating it changes the address,
 * which is the point - it is how a key that has been pasted somewhere public is
 * taken out of service.
 */
export async function ensureCampaignTickToken(): Promise<string> {
  const existing = await getCampaignTickToken()
  if (existing) return existing
  const token = randomBytes(24).toString('hex')
  await prisma.$executeRaw`
    INSERT INTO "uin_settings" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING
  `
  await prisma.$executeRaw`
    UPDATE "uin_settings"
       SET "campaign_tick_token" = ${token}, "updated_at" = now()
     WHERE "id" = 'singleton' AND "campaign_tick_token" IS NULL
  `
  return (await getCampaignTickToken()) ?? token
}

export async function getCampaignTickToken(): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ campaign_tick_token: string | null }[]>`
    SELECT "campaign_tick_token" FROM "uin_settings" WHERE "id" = 'singleton'
  `
  return rows[0]?.campaign_tick_token ?? null
}

/** A new one, which takes the old address out of service. */
export async function regenerateCampaignTickToken(): Promise<string> {
  const token = randomBytes(24).toString('hex')
  await prisma.$executeRaw`
    INSERT INTO "uin_settings" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING
  `
  await prisma.$executeRaw`
    UPDATE "uin_settings" SET "campaign_tick_token" = ${token}, "updated_at" = now()
     WHERE "id" = 'singleton'
  `
  return token
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

// ---------------------------------------------------------------------------
// Who somebody is likely to be writing to
// ---------------------------------------------------------------------------

export type RecipientSuggestion = {
  address: string
  /** The person's name where we hold one, otherwise whatever the mail headers
   *  called them. Null when neither has ever given us one. */
  name: string | null
  organisation: string | null
  /** When this inbox last exchanged anything with them. Drives the order. */
  lastAt: Date
}

/**
 * Addresses this inbox has actually dealt with, most recent first.
 *
 * Built from the messages on the inbox's own conversations rather than from the
 * people table, because the two answer different questions. The people table
 * knows everybody the site has ever met; this box wants the handful the person
 * standing in front of it is likely to be writing to next, and "who has
 * accounts@ been talking to this month" is a far better guess than "who exists".
 *
 * Both directions count. Somebody we wrote to and who never answered is still a
 * name worth offering - a supplier chased twice is exactly the address somebody
 * reaches for - and taking senders only would leave them out.
 *
 * Our own addresses are struck out. Offering `accounts@` as a suggestion inside
 * `accounts@` is offering to write to yourself, and every inbox on the site
 * appears in the To line of the colleague mail this module now files on both
 * sides, so without this the list fills up with the site's own addresses.
 *
 * The search is a plain prefix-or-contains on the address and the name, which
 * is what a person typing into a To box means. It is deliberately not the
 * people search: that one goes looking through notes and organisations, which
 * is right for a directory and wrong for a menu that has to answer between
 * keystrokes.
 */
export async function recentRecipients(opts: {
  /** The inbox being written from. Null asks across every inbox named. */
  inboxId: string | null
  /** Every inbox this person may read - the bound on what can be suggested. */
  visibleInboxIds: string[]
  search?: string | null
  limit?: number
}): Promise<RecipientSuggestion[]> {
  const scope = opts.inboxId ? [opts.inboxId] : opts.visibleInboxIds
  if (scope.length === 0) return []
  if (opts.inboxId && !opts.visibleInboxIds.includes(opts.inboxId)) return []

  const term = opts.search?.trim() ?? ''
  const like = `%${term}%`
  const filter = term
    ? Prisma.sql`AND (c."address" ILIKE ${like} OR c."name" ILIKE ${like})`
    : Prisma.empty

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    WITH correspondents AS (
      SELECT lower(a.address)                      AS address,
             max(m."sent_at")                      AS last_at,
             -- The most recent name anybody put on it, ours or theirs.
             (array_agg(m."from_name" ORDER BY m."sent_at" DESC)
                FILTER (WHERE m."from_name" IS NOT NULL AND lower(m."from_address") = lower(a.address))
             )[1]                                  AS name
        FROM "uin_messages" m
        JOIN "uin_threads" t ON t."id" = m."thread_id"
        CROSS JOIN LATERAL unnest(
               ARRAY[m."from_address"] || m."to_addresses" || m."cc_addresses"
             ) AS a(address)
       WHERE t."inbox_id" IN (${Prisma.join(scope)})
         AND m."channel" = 'email'
         AND a.address IS NOT NULL
         AND a.address <> ''
         AND position('@' in a.address) > 1
         -- Never suggest one of our own addresses.
         AND NOT EXISTS (
               SELECT 1 FROM "uin_inboxes" i WHERE lower(i."address") = lower(a.address)
             )
       GROUP BY lower(a.address)
    )
    SELECT c."address",
           COALESCE(p."display_name", c."name") AS name,
           o."name"                             AS organisation,
           c."last_at"
      FROM correspondents c
      LEFT JOIN "uin_person_identities" pi
             ON pi."match_value" = split_part(split_part(c."address", '@', 1), '+', 1)
                                || '@' || split_part(c."address", '@', 2)
      LEFT JOIN "uin_people" p ON p."id" = pi."person_id" AND p."merged_into_id" IS NULL
      LEFT JOIN "uin_organisations" o ON o."id" = p."organisation_id"
     WHERE TRUE ${filter}
     ORDER BY c."last_at" DESC
     LIMIT ${Math.min(Math.max(opts.limit ?? 8, 1), 25)}
  `

  return rows.map((r) => ({
    address: r.address as string,
    name: (r.name as string | null) ?? null,
    organisation: (r.organisation as string | null) ?? null,
    lastAt: r.last_at as Date,
  }))
}

// ---------------------------------------------------------------------------
// Merging conversations (migrations/031_thread_merges.sql).
//
// Everything happens in one transaction, and the losing conversation is KEPT
// rather than deleted - `merged_into_id` hides it from every list, and it holds
// enough for the merge to be walked back. That mirrors what person merges
// already do, for the same reason: this is the operation people regret, and one
// nobody can take back would genuinely lose somebody's history.
//
// Two things about the move are worth knowing before reading it.
//
// DUPLICATES ARE LEFT WHERE THEY ARE, not deleted. Merging the two sides of an
// internal email means the winner already holds every message the loser does -
// that is the entire point of 020_internal_threads.sql - and each of those
// would collide with a unique index on the way across. Deleting the loser's
// copy would make the merge lossy and the undo a lie, so the copy simply stays
// on the losing conversation, out of sight, and comes back with it.
//
// CHAINS ARE FLATTENED. When something that has itself absorbed others is
// merged onwards, every pointer aimed at it is re-aimed at the new winner, so
// "what did this become?" is always one hop rather than a walk. Which pointers
// moved is recorded, so undoing puts them back.
// ---------------------------------------------------------------------------

/** A conversation as a merge needs to see it: enough to decide the winner, the
 *  merged state and the addresses, and nothing more. */
export type MergeThreadRow = {
  id: string
  inboxId: string | null
  absorbedInboxIds: string[]
  mergedIntoId: string | null
  providerModule: string | null
  channel: string
  subject: string | null
  status: string
  unread: boolean
  personId: string | null
  organisationId: string | null
  lastMessageAt: Date | null
  lastDirection: string | null
  messageCount: number
  createdAt: Date
}

/** The conversations named in a merge request, in one query. Anything asked for
 *  that no longer exists is simply absent, and validateMerge says so. */
export async function threadsForMerge(ids: string[]): Promise<MergeThreadRow[]> {
  if (ids.length === 0) return []
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT t."id", t."inbox_id", t."merged_into_id", t."provider_module", t."channel",
           t."subject", t."status", t."unread", t."person_id", t."organisation_id",
           t."last_message_at", t."last_direction", t."message_count", t."created_at",
           ${ABSORBED_INBOX_IDS} AS absorbed_inbox_ids
      FROM "uin_threads" t
     WHERE t."id" IN (${Prisma.join(ids)})
  `
  return rows.map((r) => ({
    id: r.id as string,
    inboxId: (r.inbox_id as string | null) ?? null,
    absorbedInboxIds: (r.absorbed_inbox_ids as string[] | null) ?? [],
    mergedIntoId: (r.merged_into_id as string | null) ?? null,
    providerModule: (r.provider_module as string | null) ?? null,
    channel: r.channel as string,
    subject: (r.subject as string | null) ?? null,
    status: r.status as string,
    unread: !!r.unread,
    personId: (r.person_id as string | null) ?? null,
    organisationId: (r.organisation_id as string | null) ?? null,
    lastMessageAt: (r.last_message_at as Date | null) ?? null,
    lastDirection: (r.last_direction as string | null) ?? null,
    messageCount: Number(r.message_count ?? 0),
    createdAt: r.created_at as Date,
  }))
}

/** The transaction handle Prisma hands an interactive transaction. Named so the
 *  helpers below can say what they take without repeating the type. */
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/**
 * A message the winner already holds, in any of the three senses a unique index
 * cares about.
 *
 * All three are real. The Message-ID per account is how the same email in INBOX
 * and in Archive is one message; `internal_key` catches the copy whose header a
 * relay rewrote; the provider's own id is how a chat message is itself. Miss any
 * one and the UPDATE fails on a constraint halfway through, taking the whole
 * merge with it.
 */
const MESSAGE_ALREADY_ON_WINNER = (winnerId: string): Prisma.Sql => Prisma.sql`
  EXISTS (
    SELECT 1 FROM "uin_messages" w
     WHERE w."thread_id" = ${winnerId}
       AND (
         (src."connection_id" IS NOT NULL AND src."message_id_header" IS NOT NULL
            AND w."connection_id" = src."connection_id"
            AND w."message_id_header" = src."message_id_header")
         OR (src."internal_key" IS NOT NULL AND w."internal_key" = src."internal_key")
         OR (src."source" = 'provider' AND src."provider_message_id" IS NOT NULL
            AND w."source" = 'provider'
            AND w."provider_message_id" = src."provider_message_id")
       )
  )`

/** Everything a conversation says about itself that is really a summary of its
 *  messages, worked out again from the messages. Called on both sides of a
 *  merge and of an undo, because both sides change. */
async function recomputeThreadCounters(tx: Tx, threadId: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE "uin_threads" t
       SET "message_count" = COALESCE(s."count", 0),
           "last_message_at" = s."last_at",
           "last_direction" = s."last_direction",
           "preview" = COALESCE(s."snippet", t."preview"),
           "updated_at" = now()
      FROM (
        SELECT COUNT(*)::int AS "count",
               MAX(m."sent_at") AS "last_at",
               (SELECT m2."direction" FROM "uin_messages" m2
                 WHERE m2."thread_id" = ${threadId}
                 ORDER BY m2."sent_at" DESC, m2."created_at" DESC LIMIT 1) AS "last_direction",
               (SELECT m2."snippet" FROM "uin_messages" m2
                 WHERE m2."thread_id" = ${threadId}
                 ORDER BY m2."sent_at" DESC, m2."created_at" DESC LIMIT 1) AS "snippet"
          FROM "uin_messages" m
         WHERE m."thread_id" = ${threadId}
      ) s
     WHERE t."id" = ${threadId}
  `
}

/**
 * The addresses a conversation belongs to, worked out again from the merges
 * that are still standing - and, on a discussion, from the colleagues it was
 * put to.
 *
 * Recomputed rather than adjusted, so an undo needs no bookkeeping of its own
 * and a half-finished sequence of merges and undos cannot leave an address on
 * the list that nothing puts it there any more. A conversation left belonging
 * to nothing but its own inbox has its rows removed entirely - that is what
 * "never been merged" looks like, and it keeps the common case free of rows.
 *
 * The discussion half is here rather than left to the route that starts one
 * because this function DELETES first: without it, merging a discussion and
 * then undoing the merge would quietly file it out of the addresses of every
 * colleague it was put to, and nothing on the screen would say so.
 */
async function recomputeThreadInboxes(tx: Tx, threadId: string): Promise<void> {
  await tx.$executeRaw`DELETE FROM "uin_thread_inboxes" WHERE "thread_id" = ${threadId}`
  // Nothing merged into it any more and nobody it was put to, so it belongs to
  // its own address and to nothing else - which is what having no rows here
  // means. Undoing the last merge on a conversation therefore leaves it exactly
  // as it was found.
  await tx.$executeRaw`
    INSERT INTO "uin_thread_inboxes" ("thread_id", "inbox_id")
    SELECT ${threadId}, ids."inbox_id"
      FROM (
        SELECT w."inbox_id" FROM "uin_threads" w
         WHERE w."id" = ${threadId} AND w."inbox_id" IS NOT NULL
        UNION
        -- Each losing side's own addresses: the ones IT absorbed if it was
        -- itself a winner once, and its own inbox otherwise.
        SELECT COALESCE(li."inbox_id", l."inbox_id") AS "inbox_id"
          FROM "uin_threads" l
          LEFT JOIN "uin_thread_inboxes" li ON li."thread_id" = l."id"
         WHERE l."merged_into_id" = ${threadId}
           AND COALESCE(li."inbox_id", l."inbox_id") IS NOT NULL
        UNION
        -- A discussion also belongs to the address of everybody it was put to,
        -- which is how it lands in their post rather than only in the starter's
        -- (see migrations/040_discussion_parties.sql). Their OWN address only.
        SELECT i."id" AS "inbox_id"
          FROM "uin_threads" d
          JOIN "uin_inboxes" i
            ON i."kind" = 'individual' AND i."owner_user_id" = ANY (d."to_user_ids")
         WHERE d."id" = ${threadId}
      ) ids
     WHERE EXISTS (
       SELECT 1 FROM "uin_threads" l WHERE l."merged_into_id" = ${threadId}
     )
        OR EXISTS (
       SELECT 1 FROM "uin_threads" d
         JOIN "uin_inboxes" i
           ON i."kind" = 'individual' AND i."owner_user_id" = ANY (d."to_user_ids")
        WHERE d."id" = ${threadId}
     )
    ON CONFLICT DO NOTHING
  `
}

export type ThreadMergeResult = { mergeIds: string[]; winnerId: string; merged: number }

/**
 * Fold several conversations into one.
 *
 * The caller has already checked that whoever is asking may open every one of
 * them - that check needs a session and belongs in the route.
 */
export async function mergeThreads(
  winnerId: string,
  loserIdsIn: string[],
  userId: string | null,
): Promise<ThreadMergeResult | { error: string }> {
  const loserIds = [...new Set(loserIdsIn)].filter((id) => id !== winnerId)
  const found = await threadsForMerge([winnerId, ...loserIds])
  const byId = new Map(found.map((t) => [t.id, t]))

  const refusal = validateMerge({ winnerId, loserIds, found: byId })
  if (refusal) return refusal

  const winner = byId.get(winnerId)!
  const losers = loserIds.map((id) => byId.get(id)!)

  return prisma.$transaction(async (tx) => {
    const mergeIds: string[] = []

    // One at a time, and in the order given. Three conversations carrying the
    // same internal email means the second loser's copy has to be weighed
    // against a winner that has already taken the first's, which a single
    // statement over all of them could not do.
    for (const loser of losers) {
      // COALESCE, never a plain assignment. A conversation being merged onwards
      // may be carrying messages an EARLIER merge moved onto it, and those
      // messages belong to the conversation they started on - overwriting that
      // would make the first merge impossible to undo and, worse, would exempt
      // those messages from their own person's erasure, since erasure finds
      // them by exactly this column.
      const moved = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "uin_messages" src
           SET "thread_id" = ${winnerId},
               "merged_from_thread_id" = COALESCE(src."merged_from_thread_id", ${loser.id})
         WHERE src."thread_id" = ${loser.id}
           AND NOT ${MESSAGE_ALREADY_ON_WINNER(winnerId)}
        RETURNING src."id"
      `

      // An unsent reply follows its conversation. Where the same person already
      // has one on the winner, theirs stays where it is rather than one of the
      // two being thrown away - a draft is something somebody has written and
      // not sent, which makes it the last thing in here worth losing.
      const movedDrafts = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "uin_drafts" src
           SET "thread_id" = ${winnerId},
               "merged_from_thread_id" = COALESCE(src."merged_from_thread_id", ${loser.id})
         WHERE src."thread_id" = ${loser.id}
           AND NOT EXISTS (
             SELECT 1 FROM "uin_drafts" w
              WHERE w."thread_id" = ${winnerId} AND w."author_user_id" = src."author_user_id"
           )
        RETURNING src."id"
      `
      // A scheduled message waiting on this conversation waits on the merged
      // one instead, or the reply it was holding off would never be recognised.
      const heldDrafts = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "uin_drafts" SET "held_by_thread_id" = ${winnerId}
         WHERE "held_by_thread_id" = ${loser.id}
        RETURNING "id"
      `

      // A record the winner already has attached would collide with the unique
      // index, and a merge that fails because both sides had the same order on
      // them is a merge nobody can complete. The duplicate goes; the linker
      // would put it back anyway.
      await tx.$executeRaw`
        DELETE FROM "uin_record_links" l
         WHERE l."thread_id" = ${loser.id}
           AND EXISTS (
             SELECT 1 FROM "uin_record_links" w
              WHERE w."thread_id" = ${winnerId}
                AND w."module_name" = l."module_name"
                AND w."record_type" = l."record_type"
                AND w."record_id" = l."record_id"
           )
      `
      const links = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "uin_record_links" SET "thread_id" = ${winnerId}
         WHERE "thread_id" = ${loser.id}
        RETURNING "id"
      `

      // Who snoozed it, who assigned it, who was asked to look at it. The whole
      // point of the audit trail is that it can be read a fortnight later, and
      // half of it left on a conversation nothing shows is not readable.
      const events = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "uin_events" SET "thread_id" = ${winnerId}
         WHERE "thread_id" = ${loser.id}
        RETURNING "id"
      `

      // Flattening the chain: anything that had been merged into this loser is
      // now merged into the winner instead, and so is the RECORD of how it got
      // there. Both halves or neither - a thread pointing at the winner whose
      // merge record still names the loser is a merge whose undo would look for
      // its messages on a conversation they left.
      const repointed = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "uin_threads" SET "merged_into_id" = ${winnerId}, "updated_at" = now()
         WHERE "merged_into_id" = ${loser.id}
        RETURNING "id"
      `
      const repointedMerges = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "uin_thread_merges" SET "winner_id" = ${winnerId}
         WHERE "winner_id" = ${loser.id} AND "undone_at" IS NULL
        RETURNING "id"
      `

      await tx.$executeRaw`
        UPDATE "uin_threads"
           SET "merged_into_id" = ${winnerId}, "updated_at" = now()
         WHERE "id" = ${loser.id}
      `

      const snapshot = {
        loser: {
          inboxId: loser.inboxId,
          channel: loser.channel,
          subject: loser.subject,
          status: loser.status,
          unread: loser.unread,
          personId: loser.personId,
          organisationId: loser.organisationId,
          lastMessageAt: loser.lastMessageAt ? loser.lastMessageAt.toISOString() : null,
          lastDirection: loser.lastDirection,
          messageCount: loser.messageCount,
        },
        // The exact rows that moved, rather than a rule for finding them again.
        // A rule cannot tell this merge's messages from an earlier merge's that
        // came across on the same conversation, and undoing the wrong ones is
        // how a merge somebody regretted turns into two conversations neither
        // of which reads properly.
        messageIds: moved.map((r) => r.id),
        draftIds: movedDrafts.map((r) => r.id),
        linkIds: links.map((r) => r.id),
        eventIds: events.map((r) => r.id),
        heldDraftIds: heldDrafts.map((r) => r.id),
        repointedThreadIds: repointed.map((r) => r.id),
        repointedMergeIds: repointedMerges.map((r) => r.id),
      }

      const row = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "uin_thread_merges" ("winner_id", "loser_id", "user_id", "snapshot")
        VALUES (${winnerId}, ${loser.id}, ${userId}, ${JSON.stringify(snapshot)}::jsonb)
        RETURNING "id"
      `
      mergeIds.push(row[0]!.id)
    }

    await recomputeThreadInboxes(tx, winnerId)
    await recomputeThreadCounters(tx, winnerId)

    // Where the merged conversation stands, and who it is with. An open half
    // makes the whole thing open and an unread half keeps it unread - see
    // mergedStatus - because the alternative marks something done on the
    // strength of the OTHER half having been dealt with.
    const status = mergedStatus([winner.status, ...losers.map((l) => l.status)])
    const unread = mergedUnread([winner.unread, ...losers.map((l) => l.unread)])
    const personId = winner.personId ?? losers.find((l) => l.personId)?.personId ?? null
    const organisationId = winner.organisationId
      ?? losers.find((l) => l.organisationId)?.organisationId ?? null
    await tx.$executeRaw`
      UPDATE "uin_threads"
         SET "status" = ${status},
             "snooze_until" = CASE WHEN ${status} = 'snoozed' THEN "snooze_until" ELSE NULL END,
             "unread" = ${unread},
             "person_id" = ${personId},
             "organisation_id" = ${organisationId},
             "updated_at" = now()
       WHERE "id" = ${winnerId}
    `

    await tx.$executeRaw`
      INSERT INTO "uin_events" ("thread_id", "user_id", "kind", "detail")
      VALUES (${winnerId}, ${userId}, 'merged',
              ${JSON.stringify({
                mergeIds,
                loserIds: losers.map((l) => l.id),
                subjects: losers.map((l) => l.subject),
              })}::jsonb)
    `

    return { mergeIds, winnerId, merged: losers.length }
  }, { timeout: 60_000, maxWait: 15_000 })
}

export type ThreadMergeRow = {
  id: string
  winnerId: string
  loserId: string
  userId: string | null
  loserSubject: string | null
  createdAt: Date
}

/** Merges into this conversation that could still be taken back, newest first. */
export async function undoableThreadMerges(winnerId: string): Promise<ThreadMergeRow[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT m."id", m."winner_id", m."loser_id", m."user_id", m."created_at",
           t."subject" AS loser_subject
      FROM "uin_thread_merges" m
      -- The conversation itself rather than the snapshot, so a subject somebody
      -- has since corrected reads correctly. Gone entirely means the retention
      -- sweep has been through, and the merge below will refuse.
      LEFT JOIN "uin_threads" t ON t."id" = m."loser_id"
     WHERE m."winner_id" = ${winnerId} AND m."undone_at" IS NULL
     ORDER BY m."created_at" DESC
     LIMIT 20
  `
  return rows.map((r) => ({
    id: r.id as string,
    winnerId: r.winner_id as string,
    loserId: r.loser_id as string,
    userId: (r.user_id as string | null) ?? null,
    loserSubject: (r.loser_subject as string | null) ?? null,
    createdAt: r.created_at as Date,
  }))
}

/** One merge, for the route that is about to undo it. */
export async function getThreadMerge(mergeId: string): Promise<{
  id: string
  winnerId: string
  loserId: string
  undoneAt: Date | null
} | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "id", "winner_id", "loser_id", "undone_at" FROM "uin_thread_merges" WHERE "id" = ${mergeId}
  `
  const r = rows[0]
  if (!r) return null
  return {
    id: r.id as string,
    winnerId: r.winner_id as string,
    loserId: r.loser_id as string,
    undoneAt: (r.undone_at as Date | null) ?? null,
  }
}

/**
 * Put a merge back.
 *
 * Only what the merge itself moved goes back, and only from where it put it: a
 * reply that arrived afterwards belongs to the merged conversation and stays
 * there, which is the same rule person merges follow. Anything the merge moved
 * that has since been deleted simply is not there to move, and the counters are
 * worked out again from what is.
 *
 * The winning conversation keeps the state the merge gave it - if merging
 * something unanswered into something finished reopened it, undoing does not
 * quietly close it again. Reopened is the safe direction to be wrong in.
 */
export async function undoThreadMerge(
  mergeId: string,
  userId: string | null,
): Promise<{ ok: true; winnerId: string; loserId: string } | { error: string }> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_thread_merges" WHERE "id" = ${mergeId}
  `
  const row = rows[0]
  if (!row) return { error: 'That merge is not on record.' }
  if (row.undone_at) return { error: 'That merge has already been undone.' }

  const winnerId = row.winner_id as string
  const loserId = row.loser_id as string
  const snapshot = (row.snapshot ?? {}) as {
    messageIds?: string[]
    draftIds?: string[]
    linkIds?: string[]
    eventIds?: string[]
    heldDraftIds?: string[]
    repointedThreadIds?: string[]
    repointedMergeIds?: string[]
  }

  const [winner, loser] = await Promise.all([getThreadDetail(winnerId), getThreadDetail(loserId)])
  if (!winner || !loser) {
    return { error: 'One of those conversations has since gone, so this cannot be put back.' }
  }
  if (loser.mergedIntoId !== winnerId) {
    return { error: 'That conversation has moved on since, so this cannot be put back.' }
  }

  await prisma.$transaction(async (tx) => {
    // By id, and only the ones still where the merge put them. The CASE is
    // what keeps an EARLIER merge intact: a message that came onto the losing
    // conversation from a third one carries that third one's id, and clearing
    // it would strand the merge that put it there. Only provenance this merge
    // itself wrote is taken back off.
    const messageIds = snapshot.messageIds ?? []
    if (messageIds.length > 0) {
      await tx.$executeRaw`
        UPDATE "uin_messages"
           SET "thread_id" = ${loserId},
               "merged_from_thread_id" = CASE WHEN "merged_from_thread_id" = ${loserId}
                                              THEN NULL ELSE "merged_from_thread_id" END
         WHERE "id" IN (${Prisma.join(messageIds)}) AND "thread_id" = ${winnerId}
      `
    }
    const draftIds = snapshot.draftIds ?? []
    if (draftIds.length > 0) {
      await tx.$executeRaw`
        UPDATE "uin_drafts"
           SET "thread_id" = ${loserId},
               "merged_from_thread_id" = CASE WHEN "merged_from_thread_id" = ${loserId}
                                              THEN NULL ELSE "merged_from_thread_id" END
         WHERE "id" IN (${Prisma.join(draftIds)}) AND "thread_id" = ${winnerId}
      `
    }
    const heldDraftIds = snapshot.heldDraftIds ?? []
    if (heldDraftIds.length > 0) {
      await tx.$executeRaw`
        UPDATE "uin_drafts" SET "held_by_thread_id" = ${loserId}
         WHERE "id" IN (${Prisma.join(heldDraftIds)}) AND "held_by_thread_id" = ${winnerId}
      `
    }
    const linkIds = snapshot.linkIds ?? []
    if (linkIds.length > 0) {
      await tx.$executeRaw`
        UPDATE "uin_record_links" SET "thread_id" = ${loserId}
         WHERE "id" IN (${Prisma.join(linkIds)}) AND "thread_id" = ${winnerId}
      `
    }
    const eventIds = snapshot.eventIds ?? []
    if (eventIds.length > 0) {
      await tx.$executeRaw`
        UPDATE "uin_events" SET "thread_id" = ${loserId}
         WHERE "id" IN (${Prisma.join(eventIds)}) AND "thread_id" = ${winnerId}
      `
    }
    const repointed = snapshot.repointedThreadIds ?? []
    if (repointed.length > 0) {
      await tx.$executeRaw`
        UPDATE "uin_threads" SET "merged_into_id" = ${loserId}, "updated_at" = now()
         WHERE "id" IN (${Prisma.join(repointed)}) AND "merged_into_id" = ${winnerId}
      `
    }
    // And the records of how they got there, or their own undo would look for
    // its messages on a conversation they are no longer on.
    const repointedMerges = snapshot.repointedMergeIds ?? []
    if (repointedMerges.length > 0) {
      await tx.$executeRaw`
        UPDATE "uin_thread_merges" SET "winner_id" = ${loserId}
         WHERE "id" IN (${Prisma.join(repointedMerges)}) AND "winner_id" = ${winnerId}
      `
    }

    await tx.$executeRaw`
      UPDATE "uin_threads" SET "merged_into_id" = NULL, "updated_at" = now() WHERE "id" = ${loserId}
    `

    await recomputeThreadInboxes(tx, winnerId)
    await recomputeThreadInboxes(tx, loserId)
    await recomputeThreadCounters(tx, winnerId)
    await recomputeThreadCounters(tx, loserId)

    await tx.$executeRaw`
      UPDATE "uin_thread_merges" SET "undone_at" = now(), "undone_by" = ${userId} WHERE "id" = ${mergeId}
    `
    await tx.$executeRaw`
      INSERT INTO "uin_events" ("thread_id", "user_id", "kind", "detail")
      VALUES (${winnerId}, ${userId}, 'unmerged', ${JSON.stringify({ mergeId, loserId })}::jsonb)
    `
  }, { timeout: 60_000, maxWait: 15_000 })

  return { ok: true, winnerId, loserId }
}
