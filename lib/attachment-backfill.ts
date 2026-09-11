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
// So the nightly tidy walks them, a few at a time, and says nothing about it.
// There is no button and no setting, which is the right answer to "these files
// are in the wrong place" - a site owner has no way of knowing whether the
// answer to that question should be yes, and being asked it is worse than not
// being asked it. It drains itself over a few nights on a site with a lot of
// post and in one pass on a site with a little, exactly as the retention sweep
// beside it catches up on a ten-year-old mailbox.
//
// Deliberately NOT a migration. A migration runs inside a deploy, has no
// storage credentials worth relying on, cannot be stopped and cannot be
// resumed, and this is one download and one upload per file.
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

/** How many to attempt in one pass. Each one is a download and an upload of up
 *  to 25MB, and the nightly job has several other things to get through. */
const BATCH = 10

export type FilingSweepOutcome = {
  /** Files now sitting in the media library that were not before. */
  filed: number
  /** Files that could not be read or could not be written. They stay exactly
   *  where they were and are tried again tomorrow. */
  failures: number
  /** Still to do after this pass, so a night's log says whether it is nearly
   *  through the backlog or has barely started. */
  remaining: number
}

const NOTHING: FilingSweepOutcome = { filed: 0, failures: 0, remaining: 0 }

/**
 * One pass of the filing sweep, bounded by the deadline the caller has left.
 *
 * The deadline is checked before each file rather than only at the top: the
 * nightly job shares one function's worth of time between several sweeps, and a
 * single 25MB attachment on a slow morning must not be what stops the retention
 * window running.
 */
export async function sweepAttachmentFiling(
  opts: { deadline: number } = { deadline: Date.now() + 12_000 },
): Promise<FilingSweepOutcome> {
  if (Date.now() > opts.deadline) return NOTHING

  const rows = await unfiledAttachments(BATCH)
  if (rows.length === 0) return NOTHING

  let filed = 0
  let failures = 0

  for (const row of rows) {
    if (Date.now() > opts.deadline) break
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
      // the filing rules declining it after all, which leaves it where it was
      // and still in the count of what is left to do.
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
        console.warn('[unified-inbox] filing sweep could not remove the old copy of an attachment:', err)
      })
    } catch (err) {
      failures += 1
      console.warn('[unified-inbox] filing sweep could not file an attachment:', err)
    }
  }

  return { filed, failures, remaining: await unfiledAttachmentCount() }
}
