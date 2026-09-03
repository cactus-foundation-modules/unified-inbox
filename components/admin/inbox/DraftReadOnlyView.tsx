import Link from 'next/link'
import type { Draft } from '@/modules/unified-inbox/lib/types'
import { inboxHref } from '@/modules/unified-inbox/lib/list'
import { draftRecipientLabel, draftSubjectLabel } from '@/modules/unified-inbox/lib/drafts'
import { describeSendAt } from '@/modules/unified-inbox/lib/scheduled'
import { CloseIcon, PaperclipIcon } from './icons'

// Somebody else's half-written message, open for reading.
//
// A draft filed on an address is readable by whoever can read that address, the
// same as every other message on it. Changing one is still the author's alone,
// so this is a reading pane rather than the composer with its buttons greyed
// out: an editor you cannot type into invites you to try, and then has to
// explain itself. There is nothing to explain here - it plainly is not an
// editor.
//
// It borrows the composer's own dialog chrome so that opening a draft feels the
// same whoever wrote it, and closes back to wherever the list was.

type Props = {
  base: string
  params: Record<string, string>
  draft: Draft
  /** Who wrote it, said in words. An id in front of a colleague is not an
   *  answer to "whose is this". */
  authorName: string
  /** Which address it would have left as, or null for a conversation another
   *  module owns. */
  inboxName: string | null
  now: Date
  /** The site's timezone, so a departure time reads the way the site tells the
   *  time rather than the way the server does. */
  timezone: string
}

export function DraftReadOnlyView({
  base, params, draft, authorName, inboxName, now, timezone,
}: Props) {
  const closeHref = inboxHref(base, params, { compose: null, draft: null })

  return (
    <div className="uin-modal">
      <div
        className="uin-modal-card uin-modal-card-compose"
        role="dialog"
        aria-modal="true"
        aria-labelledby="uin-draft-read-title"
      >
        <div className="uin-modal-head">
          <h2 className="uin-modal-title" id="uin-draft-read-title">
            A message {authorName} started
          </h2>
          <Link className="uin-modal-close" href={closeHref} aria-label="Close">
            {CloseIcon}
          </Link>
        </div>

        <div className="uin-modal-body">
          <p className="uin-ctx-sub" style={{ marginTop: 0 }}>
            This one is {authorName}&rsquo;s, so it is here to read rather than to finish.
            {inboxName && <> It would go out as {inboxName}.</>}
          </p>

          {/* A colleague's message with a time on it goes out on its own, and
              somebody reading it needs to know that before they write the same
              thing themselves. */}
          {draft.sendState === 'scheduled' && (
            <div className="alert alert-info" role="status">
              It is set to go out {describeSendAt(draft.sendAt, now, timezone)}, on its own.
            </div>
          )}
          {draft.sendState === 'failed' && (
            <div className="alert alert-danger" role="alert">
              It was set to go out and did not.{draft.sendError ? ` ${draft.sendError}` : ''}
            </div>
          )}

          <dl className="uin-draft-read">
            <dt>To</dt>
            <dd>{draftRecipientLabel(draft)}</dd>
            {draft.cc.length > 0 && (
              <>
                <dt>Cc</dt>
                <dd>{draft.cc.join(', ')}</dd>
              </>
            )}
            <dt>Subject</dt>
            <dd>{draftSubjectLabel(draft)}</dd>
          </dl>

          {draft.body.trim()
            ? <pre className="uin-msg-text">{draft.body}</pre>
            : <p className="uin-ctx-sub">Nothing has been typed into it yet.</p>}

          {draft.attachments.length > 0 && (
            <div className="uin-msg-foot">
              {draft.attachments.map((file) => (
                // Named rather than linked: the file is attached to somebody
                // else's unsent message, and reading whose draft it is does not
                // extend to helping yourself to what is clipped to it.
                <span key={file.key} className="uin-attachment">
                  {PaperclipIcon}
                  {file.filename}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
