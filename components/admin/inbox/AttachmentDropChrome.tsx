'use client'

import type { AttachmentDrop } from './useAttachmentDrop'

// What dragging a file over a message looks like, and what it says afterwards.
//
// Apart from the hook so the behaviour and the words about it can be tested and
// read separately, and because the two composers put these in different places:
// the overlay covers whichever box is the target, while the sentence about what
// happened belongs next to the attachments themselves, where somebody is
// already looking for their file.

/** The tint and the words drawn over the box while a file is over it. Takes no
 *  pointer events: an overlay that did would become the thing being dragged
 *  over, and the box beneath it would report the pointer as having left. */
export function AttachmentDropOverlay({ dragging }: { dragging: boolean }) {
  if (!dragging) return null
  return (
    <div className="uin-drop-overlay" aria-hidden="true">
      <span className="uin-drop-overlay-label">Drop to attach</span>
    </div>
  )
}

/** How far through, and anything that could not be taken. Announced rather than
 *  merely drawn - a file that was refused for being an executable is the sort of
 *  thing somebody needs told rather than left to notice. */
export function AttachmentDropNotice({ progress, errors, dismissErrors }: Pick<
  AttachmentDrop, 'progress' | 'errors' | 'dismissErrors'
>) {
  return (
    <>
      {progress && (
        <p className="uin-recipients" role="status">
          {progress.total === 1
            ? 'Attaching your file...'
            : `Attaching ${Math.min(progress.done + 1, progress.total)} of ${progress.total}...`}
        </p>
      )}
      {errors.length > 0 && (
        <div className="alert alert-danger" role="alert">
          <ul className="uin-drop-errors">
            {errors.map((reason, index) => (
              // The sentences are the list: two files can be refused for the
              // same reason, so the reason is not a key.
              <li key={`${index}-${reason}`}>{reason}</li>
            ))}
          </ul>
          <button type="button" className="btn btn-secondary btn-sm" onClick={dismissErrors}>
            Right you are
          </button>
        </div>
      )}
    </>
  )
}
