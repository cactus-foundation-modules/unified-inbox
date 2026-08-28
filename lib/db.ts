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

/** Thread ids for referenced Message-IDs, for header threading. */
export async function threadsForMessageIds(
  messageIds: string[]
): Promise<Map<string, string>> {
  if (messageIds.length === 0) return new Map()
  const rows = await prisma.$queryRaw<{ message_id_header: string; thread_id: string }[]>`
    SELECT "message_id_header", "thread_id" FROM "uin_messages"
     WHERE "message_id_header" = ANY(${messageIds}::text[])
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
       "references_header", "from_name", "from_address", "to_addresses", "cc_addresses", "subject",
       "body_text", "body_html", "snippet", "sent_at", "has_attachments", "size_bytes", "source",
       "imap_folder", "imap_uid", "thread_match", "routed_on", "auto_kind")
    VALUES (${data.threadId}, ${data.connectionId}, ${data.direction}, 'email', ${data.messageIdHeader},
            ${data.inReplyTo}, ${data.references}::text[], ${data.fromName}, ${data.fromAddress},
            ${data.toAddresses}::text[], ${data.ccAddresses}::text[], ${data.subject}, ${data.bodyText},
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
}

export async function getAttachment(id: string): Promise<AttachmentRow | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT a.*, m."connection_id", m."imap_folder", m."imap_uid", m."thread_id", t."inbox_id"
      FROM "uin_attachments" a
      JOIN "uin_messages" m ON m."id" = a."message_id"
      JOIN "uin_threads" t ON t."id" = m."thread_id"
     WHERE a."id" = ${id}
  `
  const r = rows[0]
  if (!r) return null
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
    imapUid: bigintToNumber(r.imap_uid),
    threadId: r.thread_id as string,
    inboxId: (r.inbox_id as string | null) ?? null,
  }
}

export async function listAttachmentsForMessage(messageId: string): Promise<AttachmentRow[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "uin_attachments" WHERE "message_id" = ${messageId} ORDER BY "created_at" ASC
  `
  const out: AttachmentRow[] = []
  for (const row of rows) {
    const full = await getAttachment(row.id)
    if (full) out.push(full)
  }
  return out
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
  `
  return rows.map((r) => r.ref).filter((r): r is string => !!r)
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
