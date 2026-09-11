import type { MediaProviderType } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getOrCreateFolderByPath, resolveFolderPath } from '@/lib/media/organise'
import { deleteMedia, mediaKeyPrefix } from '@/lib/media/upload'
import { attachmentKeySharedElsewhere, type StoredObjectRef } from './db'

// ---------------------------------------------------------------------------
// Where an email's files live in the media library.
//
// This module used to keep every attachment under one flat private prefix with
// no library row at all, so a customer's invoice could not turn up in the media
// picker for everybody holding media permission. The site owner asked for the
// opposite: attachments belong on the media page with everything else, filed by
// who the correspondence was with.
//
// So they are ordinary library items now, in a folder tree built from the
// conversation:
//
//     Inbox / <their address> / Received / <attachmentId>-<filename>
//     Inbox / <their address> / Sent     / <attachmentId>-<filename>
//
// THEIR address in both directions, not ours. An outbound message's From is
// whichever of our own mailboxes sent it, so filing Sent by From would pile
// every reply the site has ever written into three or four folders named after
// itself. Filing both halves by the correspondent puts one person's whole
// paper trail in one folder, which is the question somebody opening this is
// actually asking.
//
// Two kinds of file deliberately stay OUT of the library, and both would
// otherwise drown it:
//
//   - Inline parts (a signature logo, a pasted screenshot). One "image001.png"
//     per email from anybody with a fancy footer. They keep the old private
//     prefix and the media usage provider keeps vouching for them.
//   - Anything with no correspondent to file it under - an internal note, or a
//     message whose address never arrived. Same treatment.
//
// The attachment id stays in the filename, and it is doing real work rather
// than merely avoiding collisions: the media Worker serves any object under
// `media/` to whoever asks for it by key, so an attachment's privacy rests on
// its key being unguessable. A folder path anybody could guess from an email
// address plus a plain filename would not be.
// ---------------------------------------------------------------------------

/** The library folder every inbox attachment is filed beneath. */
export const INBOX_ROOT_FOLDER = 'Inbox'

/** The two leaves under a correspondent's folder. */
export const RECEIVED_FOLDER = 'Received'
export const SENT_FOLDER = 'Sent'

/** What a message has to say about itself before its files can be filed. */
export type FilingContext = {
  direction: string
  fromAddress: string | null
  toAddresses: string[]
  /** Present on a part the markup points at by Content-ID. Those stay private. */
  contentId: string | null
}

/**
 * The correspondent's address and which way the message went, or null when
 * this one is not going into the library at all.
 *
 * Deliberately null rather than a fallback folder: "Unknown" would collect
 * every note and every malformed header into one bin nobody can act on, and an
 * attachment left on the private prefix is still readable in the conversation
 * it belongs to, which is where anybody looking for it will look first.
 */
export function filingFor(context: FilingContext): { address: string; leaf: string } | null {
  if (context.contentId) return null

  const address = context.direction === 'in'
    ? context.fromAddress
    : context.direction === 'out'
      ? (context.toAddresses[0] ?? null)
      : null
  if (!address) return null

  const clean = address.trim().toLowerCase()
  if (!clean) return null

  return {
    address: clean,
    leaf: context.direction === 'in' ? RECEIVED_FOLDER : SENT_FOLDER,
  }
}

/** The library folder for a message's files, creating the tree on first use. */
export async function folderForFiling(
  filing: { address: string; leaf: string },
): Promise<{ folderId: string; folderPath: string } | null> {
  const folderId = await getOrCreateFolderByPath([INBOX_ROOT_FOLDER, filing.address, filing.leaf])
  if (!folderId) return null
  const folderPath = await resolveFolderPath(folderId)
  if (!folderPath) return null
  return { folderId, folderPath }
}

/**
 * The storage key for a filed attachment: the provider's media prefix, then the
 * folder path core resolved from the tree above, then the attachment's own id
 * and name.
 *
 * The path has to be the one resolveFolderPath returns rather than one built
 * from the display names here, because the media library's folders are
 * PHYSICAL - the reconcile that maps storage back onto folders matches each
 * path segment against the sanitised folder name, and a key spelt any other way
 * would look to it like an item sitting outside the tree.
 */
export function filedAttachmentKey(
  provider: MediaProviderType,
  folderPath: string,
  attachmentId: string,
  safeName: string,
): string {
  return `${mediaKeyPrefix(provider)}${folderPath}/${attachmentId}-${safeName}`
}


/**
 * Takes one stored object out of storage, and its library row with it.
 *
 * The ownership check is the whole point. Two quite different things sit in an
 * attachment's media_key: bytes this module wrote, and a library item somebody
 * picked out of the media library and attached - a product photograph, a price
 * list - or the original of a message being forwarded, whose bytes belong to
 * the message it came from. Deleting the email must not take either of those
 * with it, and before owns_object existed it did: emptying the bin removed a
 * product image from storage and left its library row pointing at nothing.
 *
 * The second check is sharing. A forward travels with the original's
 * attachment, and the row written for the forward carries the very same key -
 * one object, two rows - so the bytes may not go while either of them is still
 * standing. When BOTH are being thrown away at once, a whole conversation or a
 * bin being emptied, the rows are still there while this loop runs, so each
 * sees the other and neither deletes: the object is left behind as a leftover
 * the storage check can offer up. A file nobody is holding is a nuisance; a
 * file that has gone while a message still shows a paperclip for it is a
 * support ticket nobody can answer.
 *
 * Bytes first, row second, exactly as the retention sweep does it. Interrupted
 * between the two, what is left is an object nothing points at, which the
 * storage check can offer up; the other order leaves a library row whose
 * thumbnail is a broken box nobody can explain.
 */
export async function releaseStoredObject(object: StoredObjectRef): Promise<void> {
  if (!object.ownsObject) return
  if (await attachmentKeySharedElsewhere(object.attachmentId, object.mediaKey)) return
  await deleteMedia(object.mediaProvider as MediaProviderType, object.mediaKey)
  if (object.mediaId) await prisma.media.deleteMany({ where: { id: object.mediaId } })
}
