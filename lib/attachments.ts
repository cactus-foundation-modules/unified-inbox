import { simpleParser } from 'mailparser'
import { getActiveMediaProvider, isMediaProviderConfigured } from '@/lib/config/env'
import { uploadMedia, downloadMedia, mediaKeyPrefix, saveMediaRecord } from '@/lib/media/upload'
import { prisma } from '@/lib/db/prisma'
import type { MediaProviderType } from '@prisma/client'
import { credentialsForConnection, openMailbox } from './imap'
import { attachmentFilingContext, getAttachment, recordAttachmentStored, type AttachmentRow } from './db'
import { filedAttachmentKey, filingFor, folderForFiling } from './attachment-filing'

// ---------------------------------------------------------------------------
// Attachments, and where they live.
//
// They are media library items, filed under who the correspondence was with -
// Inbox / their address / Received, or / Sent. lib/attachment-filing.ts builds
// that tree and explains the shape of it.
//
// This was the other way round until the site owner asked for it: everything
// went under one flat private prefix with no library row, so that an invoice
// pulled out of accounts@ could not appear in the media picker for everybody
// holding media permission. Filing them in the library gives that up on
// purpose, and anybody with media permission can now see them.
//
// Two things still keep the old arrangement, because both would otherwise
// drown the library: inline parts (a signature logo, a pasted screenshot) and
// anything with no correspondent to file it under. Those have no library row,
// which leaves the storage check looking at an object with no row and nothing
// pointing at it - the shape of a leftover. lib/media-usage-provider.ts vouches
// for them: it hands core the keys and urls held here, the storage check counts
// them as claimed, and nothing offers to delete them. That file is not optional.
//
// Bytes are fetched only when somebody opens one (D17, and the sync engine's
// 25 second budget), and served only through a route that re-checks who is
// asking. Nothing here ever returns a storage url to a browser.
// ---------------------------------------------------------------------------

/** The private folder, inside the provider's own media prefix, for the files
 *  that are deliberately NOT library items: inline parts, anything with no
 *  correspondent, and a dropped file waiting for its message to be sent. Also
 *  where every attachment lived before they were filed into the library, which
 *  is what the backfill walks. */
export const ATTACHMENT_FOLDER = 'unified-inbox'

/** Refuse to bring anything ludicrous back through a serverless function. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

export function safeFilename(filename: string): string {
  const cleaned = filename
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return cleaned.slice(0, 80) || 'attachment'
}

/**
 * The storage key for an attachment that is NOT going into the library: the
 * provider's media prefix, then this module's private folder, then the message
 * and the attachment's own id. The attachment id makes it unique without a
 * nanoid, and keeping the message id in the path means a thread's files sit
 * together when somebody has to go and look.
 */
export function attachmentKey(
  provider: MediaProviderType,
  messageId: string,
  attachmentId: string,
  filename: string,
): string {
  return `${mediaKeyPrefix(provider)}${ATTACHMENT_FOLDER}/${messageId}/${attachmentId}-${safeFilename(filename)}`
}

/**
 * The storage key for a file somebody has just dragged onto a message.
 *
 * The same prefix as an inbound attachment, one folder along, and for the same
 * reason: no media library row, so nothing a person attaches to an email turns
 * up in the picker for everybody who happens to hold media permission.
 *
 * The random id is doing real work rather than merely avoiding collisions. The
 * media Worker serves any object under `media/` to anyone who asks for it by
 * key, so an attachment's privacy rests on its key being unguessable - which is
 * exactly how inbound attachment keys are built, from two ids nobody outside
 * the database has seen.
 */
export function outboundUploadKey(
  provider: MediaProviderType,
  uploadId: string,
  filename: string,
): string {
  return `${mediaKeyPrefix(provider)}${ATTACHMENT_FOLDER}/outbound/${uploadId}-${safeFilename(filename)}`
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
 * Writes the bytes into storage - and, when the message has a correspondent to
 * file them under, into the media library as an ordinary item - so the next
 * person to open it does not go back to the mail server.
 *
 * The single place bytes are stored, for both directions and for a message
 * another module sent. Three callers, one rule about folders: a rule each of
 * them had to remember to apply would be applied two ways out of three.
 *
 * A storage failure is not fatal: the reader already has their file, and the
 * only cost is fetching it again next time. Returns where the bytes ended up,
 * or null when nothing was stored - which is how the backfill knows whether
 * there is an old copy left to tidy away, and what to point a forward at.
 */
export async function cacheAttachment(
  attachment: { id: string; messageId: string; filename: string },
  buffer: Buffer,
  contentType: string,
): Promise<{ key: string; url: string } | null> {
  try {
    const provider = await getActiveMediaProvider()
    if (!provider || !isMediaProviderConfigured(provider)) return null

    const context = await attachmentFilingContext(attachment.id)
    const filing = context ? filingFor(context) : null
    const folder = filing ? await folderForFiling(filing) : null

    const key = folder
      ? filedAttachmentKey(provider, folder.folderPath, attachment.id, safeFilename(attachment.filename))
      : attachmentKey(provider, attachment.messageId, attachment.id, attachment.filename)

    const result = await uploadMedia(
      buffer,
      contentType,
      provider,
      attachment.filename,
      // Only meaningful to the providers that keep folders of their own
      // (Cloudinary, ImageKit); the S3 family takes the whole key above.
      folder?.folderPath,
      false,
      key,
    )

    const media = folder
      ? await libraryRowFor({
          key: result.key,
          url: result.url,
          provider,
          mimeType: contentType || 'application/octet-stream',
          sizeBytes: result.sizeBytes,
          originalName: attachment.filename,
          folderId: folder.folderId,
        })
      : null

    await recordAttachmentStored(attachment.id, {
      key: result.key,
      provider,
      url: result.url,
      sizeBytes: result.sizeBytes,
      mediaId: media?.id ?? null,
    })
    return { key: result.key, url: result.url }
  } catch {
    // Storage is a cache in this direction, not the record. Carry on.
    return null
  }
}

/**
 * The library row for a key, made if it is not already there.
 *
 * Storing the same attachment twice is ordinary rather than exceptional - a
 * message re-fetched after its bytes were removed lands on the very same key,
 * because the key is built from ids rather than from a nanoid - and Media.key
 * is unique, so a second plain insert would throw and be swallowed by the catch
 * above, leaving the file stored and the library none the wiser.
 */
async function libraryRowFor(data: {
  key: string
  url: string
  provider: MediaProviderType
  mimeType: string
  sizeBytes: number
  originalName: string
  folderId: string
}): Promise<{ id: string }> {
  const existing = await prisma.media.findUnique({ where: { key: data.key }, select: { id: true } })
  if (existing) return existing
  return saveMediaRecord(data)
}
