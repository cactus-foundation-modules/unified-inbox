import { prisma } from '@/lib/db/prisma'
import type { MediaReferenceChange } from '@/lib/media/reference-rewriters'

// Rewriter for the core.media-reference-rewriters extension point.
//
// Attachments are media library items now (lib/attachment-filing.ts), and the
// library moves an item's bytes to a fresh key and url without the item's
// identity changing at all: optimise re-encodes it, resize and crop remake it,
// replace-file swaps it, and renaming or moving a folder relocates everything
// underneath it - which is exactly what an owner tidying up the Inbox folder
// would do.
//
// Core rewrites the references it owns. It cannot reach the three columns this
// module keeps in uin_attachments, and without this the attachment on a
// conversation would point at a blob that has just been deleted: a paperclip
// that opens onto nothing, while the media library looks perfectly healthy.
//
// Every value is matched exactly and nothing is parsed, because the four
// strings are not always what their names suggest - the library's de-duplicate
// path calls this a second time with media ids in the key slots, so that the
// row surviving a merge can be followed. media_id is rewritten on that pass and
// nothing else matches; on an ordinary move, media_id matches nothing and the
// key and url are rewritten instead.
//
// Allowed to throw, and core runs it BEFORE deleting the blob that the move
// superseded - so a failure here leaves the old bytes in place and the old url
// still resolving, which is recoverable in a way a quiet 404 is not.
export async function unifiedInboxMediaReferenceRewriter(change: MediaReferenceChange): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "uin_attachments"
       SET "media_key" = CASE WHEN "media_key" = ${change.oldKey} THEN ${change.newKey} ELSE "media_key" END,
           "media_url" = CASE WHEN "media_url" = ${change.oldUrl} THEN ${change.newUrl} ELSE "media_url" END,
           "media_id"  = CASE WHEN "media_id"  = ${change.oldKey} THEN ${change.newKey} ELSE "media_id"  END
     WHERE "media_key" = ${change.oldKey}
        OR "media_url" = ${change.oldUrl}
        OR "media_id"  = ${change.oldKey}
  `
}
