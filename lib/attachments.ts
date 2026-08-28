import { simpleParser } from 'mailparser'
import { getActiveMediaProvider, isMediaProviderConfigured } from '@/lib/config/env'
import { uploadMedia, downloadMedia, mediaKeyPrefix } from '@/lib/media/upload'
import type { MediaProviderType } from '@prisma/client'
import { credentialsForConnection, openMailbox } from './imap'
import { getAttachment, recordAttachmentStored, type AttachmentRow } from './db'

// ---------------------------------------------------------------------------
// Attachments, and why they are not in the media library.
//
// A customer's invoice pulled out of accounts@ must never turn up in the media
// picker for everybody who happens to hold media permission - that would undo
// the whole of per-inbox access in one step. Core's uploadMedia writes the
// object and nothing else; it is the CALLER that mints the library row. So
// these are written under this module's own key prefix with no row at all, and
// they are invisible to the library by construction rather than by a filter
// somebody could later forget.
//
// Which leaves the other half of the problem. The storage check classifies an
// object with no row and nothing pointing at it as ORPHANED, and the repair
// offers orphans up for deletion - which would quietly bin every email
// attachment on the site. lib/media-usage-provider.ts is what vouches for them:
// it hands core the keys and urls held here, the storage check counts them as
// claimed, and nothing offers to delete them. That file is not optional.
//
// Bytes are fetched only when somebody opens one (D17, and the sync engine's
// 25 second budget), and served only through a route that re-checks who is
// asking. Nothing here ever returns a storage url to a browser.
// ---------------------------------------------------------------------------

/** Everything this module writes lives under this, inside the provider's own
 *  media prefix. One prefix, so a site can see at a glance what the inbox is
 *  holding, and so a future retention sweep has something to walk. */
export const ATTACHMENT_FOLDER = 'unified-inbox'

/** Refuse to bring anything ludicrous back through a serverless function. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

function safeFilename(filename: string): string {
  const cleaned = filename
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return cleaned.slice(0, 80) || 'attachment'
}

/**
 * The storage key for one attachment: the provider's media prefix, then this
 * module's folder, then the message and the attachment's own id. The attachment
 * id makes it unique without a nanoid, and keeping the message id in the path
 * means a thread's files sit together when somebody has to go and look.
 */
export function attachmentKey(
  provider: MediaProviderType,
  messageId: string,
  attachmentId: string,
  filename: string,
): string {
  return `${mediaKeyPrefix(provider)}${ATTACHMENT_FOLDER}/${messageId}/${attachmentId}-${safeFilename(filename)}`
}

export type FetchedAttachment = {
  buffer: Buffer
  contentType: string
  filename: string
}

export type AttachmentFetchFailure = { ok: false; reason: string; status: number }
export type AttachmentFetchSuccess = { ok: true } & FetchedAttachment

/**
 * The bytes for one attachment: from storage if we have already fetched them,
 * otherwise from the mail server, which is then cached under our own key so the
 * second person to open it costs nothing.
 *
 * Access is NOT checked here - the caller does it, because the caller is the
 * one holding the session. See the download route.
 */
export async function loadAttachmentBytes(
  attachmentId: string,
): Promise<AttachmentFetchSuccess | AttachmentFetchFailure> {
  const attachment = await getAttachment(attachmentId)
  if (!attachment) return { ok: false, reason: 'That attachment no longer exists.', status: 404 }

  if (attachment.mediaKey && attachment.mediaProvider && attachment.mediaUrl) {
    try {
      const buffer = await downloadMedia(
        attachment.mediaProvider as MediaProviderType,
        attachment.mediaKey,
        attachment.mediaUrl,
      )
      return {
        ok: true,
        buffer,
        contentType: attachment.contentType ?? 'application/octet-stream',
        filename: attachment.filename,
      }
    } catch {
      // The object has gone from storage. Fall through and fetch it from the
      // mail server again rather than telling somebody their invoice is lost.
    }
  }

  return fetchFromMailbox(attachment)
}

async function fetchFromMailbox(
  attachment: AttachmentRow,
): Promise<AttachmentFetchSuccess | AttachmentFetchFailure> {
  if (!attachment.connectionId || !attachment.imapFolder || attachment.imapUid === null) {
    return {
      ok: false,
      reason: 'This file has not been downloaded yet and the message it came with can no longer be found on the mail server.',
      status: 404,
    }
  }

  let client = null
  try {
    client = await openMailbox(await credentialsForConnection(attachment.connectionId))
    const lock = await client.getMailboxLock(attachment.imapFolder)
    let source: Buffer | null = null
    try {
      const message = await client.fetchOne(String(attachment.imapUid), { source: true }, { uid: true })
      source = message && message.source ? Buffer.from(message.source) : null
    } finally {
      lock.release()
    }
    if (!source) {
      return { ok: false, reason: 'That message is no longer in the mailbox, so its attachment cannot be fetched.', status: 404 }
    }

    const parsed = await simpleParser(source)
    const index = Number(attachment.imapPartId ?? '0')
    const found = parsed.attachments[Number.isFinite(index) ? index : 0]
      ?? parsed.attachments.find((a) => (a.filename ?? '') === attachment.filename)
    if (!found) {
      return { ok: false, reason: 'That attachment is no longer part of the message.', status: 404 }
    }

    const buffer = Buffer.from(found.content)
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      return { ok: false, reason: 'That file is too large to open here. Open it in your mail app instead.', status: 413 }
    }

    const contentType = found.contentType || attachment.contentType || 'application/octet-stream'
    await cacheAttachment(attachment, buffer, contentType)
    return { ok: true, buffer, contentType, filename: attachment.filename }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: `The mail server would not hand that file over: ${message}`, status: 502 }
  } finally {
    if (client) await client.logout().catch(() => {})
  }
}

/**
 * Writes the bytes under our own key so the next person to open it does not go
 * back to the mail server. A storage failure is not fatal: the reader already
 * has their file, and the only cost is fetching it again next time.
 */
export async function cacheAttachment(
  attachment: { id: string; messageId: string; filename: string },
  buffer: Buffer,
  contentType: string,
): Promise<void> {
  try {
    const provider = await getActiveMediaProvider()
    if (!provider || !isMediaProviderConfigured(provider)) return
    const key = attachmentKey(provider, attachment.messageId, attachment.id, attachment.filename)
    const result = await uploadMedia(
      buffer,
      contentType,
      provider,
      attachment.filename,
      undefined,
      false,
      key,
    )
    // Deliberately NO saveMediaRecord: a library row here is the leak. The
    // media usage provider is what stops the storage check calling this orphaned.
    await recordAttachmentStored(attachment.id, {
      key: result.key,
      provider,
      url: result.url,
      sizeBytes: result.sizeBytes,
    })
  } catch {
    // Storage is a cache in this direction, not the record. Carry on.
  }
}
