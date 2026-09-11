import type { MediaProviderType } from '@prisma/client'
import { deleteMedia, downloadMedia } from '@/lib/media/upload'
import { cacheAttachment } from './attachments'
import { repointAttachmentsSharingKey, unfiledAttachmentCount, unfiledAttachments } from './db'

// ---------------------------------------------------------------------------
// Moving the files that were already here into the media library.
//
// Everything this module stored before lib/attachment-filing.ts existed sits in
// one flat private folder with no library row, so none of it appears on the
// media page. Nothing moves it on its own: the filing happens where bytes are
// STORED, and an attachment whose bytes were fetched last March is never stored
// again.
//
// So this walks them, a batch at a time, from a button on the settings screen.
// A batch rather than a job, because the work is one download and one upload
// per file and there is no telling in advance whether a site has eleven of them
// or eleven thousand - the screen keeps asking until the count reaches zero,
// which also means a site owner can stop watching at any point and the next
// press carries on from where it left off.
//
// Deliberately NOT a migration. A migration runs inside a deploy, has no
// storage credentials worth relying on, and cannot be stopped or resumed; and a
// site that has never wanted its attachments in the library should not have
// them moved there by an update it did not ask for.
//
// Order of work, per file, and the reason for it:
//
//   1. Read the bytes from where they are.
//   2. Write them to the new key and mint the library row (cacheAttachment,
//      which is the one place that decides where a file belongs).
//   3. Only then remove the old copy.
//
// Interrupted between 2 and 3, what is left behind is a copy of a file nothing
// points at - which the storage check can offer up, and which costs a few pence
// a year in the meantime. The other order loses the file.
// ---------------------------------------------------------------------------

/** How long one press may spend working before it answers. Comfortably inside
 *  the ceiling a module route runs under, with room for the last file to
 *  finish. */
const BUDGET_MS = 40_000

/** How many to attempt in one press, whatever the budget allows. Each one is a
 *  download and an upload of up to 25MB; a batch bigger than this would spend
 *  most presses hitting the clock rather than the count. */
const BATCH = 10

export type BackfillOutcome = {
  /** Files now sitting in the media library that were not before. */
  filed: number
  /** Files that could not be read or could not be written. They stay exactly
   *  where they were and will be tried again on the next press. */
  failures: number
  /** Still to do once this press finished. */
  remaining: number
}

export async function backfillAttachments(): Promise<BackfillOutcome> {
  const deadline = Date.now() + BUDGET_MS
  const rows = await unfiledAttachments(BATCH)

  let filed = 0
  let failures = 0

  for (const row of rows) {
    if (Date.now() > deadline) break
    try {
      const provider = row.mediaProvider as MediaProviderType
      const bytes = await downloadMedia(provider, row.mediaKey, row.mediaUrl)

      const stored = await cacheAttachment(
        { id: row.id, messageId: row.messageId, filename: row.filename },
        Buffer.from(bytes),
        row.contentType ?? 'application/octet-stream',
      )

      // Two ways this is not a file that moved, and neither may be counted as
      // one. Null is a write that failed, and the row still points at the old
      // copy - the one thing that must not now be deleted. The same key back is
      // the filing rules declining it after all, which leaves it exactly where
      // it was AND still in the count of what is left to do: called a success,
      // it would have the screen pressing the button for ever on a file that
      // never budges.
      if (!stored || stored.key === row.mediaKey) {
        failures += 1
        continue
      }
      filed += 1

      // A forward is holding the very same key - one object, two rows - and the
      // old copy is about to go. Point it at where the bytes went before
      // deleting anything, so the forwarded message keeps its paperclip. It is
      // deliberately not given the library row or the ownership: there is one
      // object, one library item and one owner.
      await repointAttachmentsSharingKey(row.mediaKey, row.id, stored.key, stored.url)
      await deleteMedia(provider, row.mediaKey).catch((err) => {
        // The file is safely in its new home and the row points at it. All that
        // is left behind is a copy nobody is holding, which the storage check
        // will offer up.
        console.warn('[unified-inbox] backfill could not remove the old copy of an attachment:', err)
      })
    } catch (err) {
      failures += 1
      console.warn('[unified-inbox] backfill could not file an attachment:', err)
    }
  }

  return { filed, failures, remaining: await unfiledAttachmentCount() }
}
