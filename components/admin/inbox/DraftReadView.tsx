import Link from 'next/link'
import type { Draft } from '@/modules/unified-inbox/lib/types'
import { formatFull, formatWhen, inboxHref } from '@/modules/unified-inbox/lib/list'
import { draftBodyText, draftSubjectLabel } from '@/modules/unified-inbox/lib/drafts'
import { scheduleLabel } from '@/modules/unified-inbox/lib/scheduled'
import { MessageText } from './MessageText'
import { PaperclipIcon } from './icons'

// A colleague's half-written message, read and nothing else.
//
// It exists because a Drafts folder that only listed subjects would answer half
// the question somebody covering an address actually has. "Sam has started
// something to the Hendersons" is worth knowing; whether it already says the
// thing you were about to say is the reason you looked.
//
// Read is the whole of it, and the shape of this file says so - there is no
// form here, no button that posts anything, and no route behind it that would
// take one. A draft may only be changed or sent by whoever wrote it (see
// canEditDraft in lib/drafts.ts), and offering a Send that the server would
// refuse is worse than offering nothing.
//
// The body goes in as TEXT. A draft written in the rich box is markup, and this
// is the one screen that shows somebody else's markup without it having been
// through the reply box that cleaned it on the way in - so it is flattened to
// words by draftBodyText and handed to the same plain-text renderer an ordinary
// message with no markup uses. Nothing here is ever set as HTML.

type Props = {
  base: string
  params: Record<string, string>
  draft: Draft
  /** Whose it is, for the line that says so. The address's own name when the
   *  account behind it has gone - an owner-less address is still somewhere an
   *  administrator has to be able to read. */
  ownerName: string
  /** What the address is called, for the same line. */
  inboxName: string
  now: Date
  timezone: string
}

export function DraftReadView({
  base, params, draft, ownerName, inboxName, now, timezone,
}: Props) {
  const body = draftBodyText(draft).trim()
  // When it is set to go out, or why the last attempt was refused. Worth saying
  // loudest of all on somebody else's draft: a message leaving on its own on
  // Thursday is a message you must not send a second copy of today.
  const going = scheduleLabel(draft, now, timezone)

  return (
    <div className="uin-draft-read">
      <div className="uin-draft-read-head">
        <h2 className="uin-draft-read-subject">{draftSubjectLabel(draft)}</h2>
        <p className="uin-draft-read-who">
          Started by {ownerName} on {inboxName}, last touched{' '}
          <span title={formatFull(draft.updatedAt, timezone)}>
            {formatWhen(draft.updatedAt, now, timezone)}
          </span>
        </p>
        <dl className="uin-draft-read-fields">
          <div>
            <dt>To</dt>
            <dd>{draft.to.length > 0 ? draft.to.join(', ') : 'Nobody yet'}</dd>
          </div>
          {draft.cc.length > 0 && (
            <div>
              <dt>Cc</dt>
              <dd>{draft.cc.join(', ')}</dd>
            </div>
          )}
          {/* Bcc deliberately absent. A blind copy is a fact its author kept off
              the message, and a folder somebody else reads is not the place it
              stops being one. */}
          {draft.threadId && (
            <div>
              <dt>Answering</dt>
              <dd>
                <Link href={inboxHref(base, params, {
                  id: draft.threadId, draft: null, compose: null, page: null,
                })}>
                  Open the conversation
                </Link>
              </dd>
            </div>
          )}
          {draft.attachments.length > 0 && (
            <div>
              <dt>Attached</dt>
              <dd>
                {PaperclipIcon}{' '}
                {draft.attachments.length === 1
                  ? draft.attachments[0]!.filename
                  : `${draft.attachments.length} files`}
              </dd>
            </div>
          )}
        </dl>
        {going && (
          <p className={draft.sendState === 'failed' ? 'alert alert-danger' : 'alert alert-info'}>
            {going}
          </p>
        )}
      </div>

      <div className="uin-draft-read-body">
        {body
          ? <MessageText text={body} />
          : <p className="uin-draft-read-nothing">Nothing written yet - only the details above.</p>}
      </div>

      {/* Said once, at the foot, rather than as a disabled button beside every
          line: there is nothing here to press, and the sentence explains why
          better than a greyed-out Send would. */}
      <p className="uin-draft-read-note">
        This is {ownerName}&apos;s writing, so it is here to read only. Only they can finish it or
        send it.
      </p>
    </div>
  )
}
