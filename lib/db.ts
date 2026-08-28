import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { encryptSecret } from '@/lib/crypto/secrets'
import { normaliseAddress } from './addresses'
import type {
  AttachmentFetchMode,
  Connection,
  Inbox,
  InboxAccess,
  SendTransport,
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
}): Promise<Connection> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    INSERT INTO "uin_connections"
      ("label", "imap_host", "imap_port", "imap_username", "imap_password_encrypted", "imap_tls", "extra_folders")
    VALUES (${data.label}, ${data.imapHost}, ${data.imapPort}, ${data.imapUsername},
            ${encryptSecret(data.imapPassword)}, ${data.imapTls ?? true},
            ${data.extraFolders ?? []}::text[])
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
}): Promise<Connection | null> {
  const sets: Prisma.Sql[] = []
  if (data.label !== undefined) sets.push(Prisma.sql`"label" = ${data.label}`)
  if (data.imapHost !== undefined) sets.push(Prisma.sql`"imap_host" = ${data.imapHost}`)
  if (data.imapPort !== undefined) sets.push(Prisma.sql`"imap_port" = ${data.imapPort}`)
  if (data.imapUsername !== undefined) sets.push(Prisma.sql`"imap_username" = ${data.imapUsername}`)
  if (data.imapTls !== undefined) sets.push(Prisma.sql`"imap_tls" = ${data.imapTls}`)
  if (data.extraFolders !== undefined) sets.push(Prisma.sql`"extra_folders" = ${data.extraFolders}::text[]`)
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
    signatureHtml: (r.signature_html as string | null) ?? null,
    appendToSent: !!r.append_to_sent,
    colour: (r.colour as string | null) ?? null,
    sortOrder: Number(r.sort_order ?? 0),
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
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
  signatureHtml?: string | null
  appendToSent?: boolean
  colour?: string | null
  sortOrder?: number
}

export async function createInbox(data: InboxInput): Promise<Inbox> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    INSERT INTO "uin_inboxes"
      ("name", "address", "connection_id", "imap_folder", "sent_folder", "is_catch_all",
       "send_transport", "brevo_api_key_encrypted", "smtp_host", "smtp_port", "smtp_username",
       "smtp_password_encrypted", "from_name", "signature_html", "append_to_sent", "colour", "sort_order")
    VALUES (${data.name}, ${normaliseAddress(data.address)}, ${data.connectionId ?? null},
            ${data.imapFolder ?? 'INBOX'}, ${data.sentFolder ?? null}, ${data.isCatchAll ?? false},
            ${data.sendTransport ?? 'brevo'}, ${optionalSecret(data.brevoApiKey) ?? null},
            ${data.smtpHost ?? null}, ${data.smtpPort ?? null}, ${data.smtpUsername ?? null},
            ${optionalSecret(data.smtpPassword) ?? null}, ${data.fromName ?? null},
            ${data.signatureHtml ?? null}, ${data.appendToSent ?? false}, ${data.colour ?? null},
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
  if (data.signatureHtml !== undefined) sets.push(Prisma.sql`"signature_html" = ${data.signatureHtml}`)
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

/** Every other inbox using this address, so a duplicate is refused with a
 *  sentence rather than a unique-constraint error. */
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

/** Every access row on the site, for resolving one user's view of the rail in
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

/** Replaces an inbox's whole guest list in one go. An empty list means "back to
 *  everybody who can view the inbox at all", which is the difference between no
 *  rows and a row per person. */
export async function setInboxAccess(
  inboxId: string,
  entries: Array<{ userId: string; canReply: boolean }>
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
  })
}

// ---------------------------------------------------------------------------
// Module settings (singleton row)
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS: UnifiedInboxSettings = {
  backfillMonths: 12,
  retentionMonths: null,
  attachmentFetch: 'lazy',
  autoLink: true,
  defaultInboxId: null,
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
    attachmentFetch: (r.attachment_fetch as AttachmentFetchMode) ?? 'lazy',
    autoLink: r.auto_link === undefined ? true : !!r.auto_link,
    defaultInboxId: (r.default_inbox_id as string | null) ?? null,
  }
}

export async function updateSettings(data: Partial<UnifiedInboxSettings>): Promise<UnifiedInboxSettings> {
  const sets: Prisma.Sql[] = []
  if (data.backfillMonths !== undefined) sets.push(Prisma.sql`"backfill_months" = ${data.backfillMonths}`)
  if (data.retentionMonths !== undefined) sets.push(Prisma.sql`"retention_months" = ${data.retentionMonths}`)
  if (data.attachmentFetch !== undefined) sets.push(Prisma.sql`"attachment_fetch" = ${data.attachmentFetch}`)
  if (data.autoLink !== undefined) sets.push(Prisma.sql`"auto_link" = ${data.autoLink}`)
  if (data.defaultInboxId !== undefined) sets.push(Prisma.sql`"default_inbox_id" = ${data.defaultInboxId}`)
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
