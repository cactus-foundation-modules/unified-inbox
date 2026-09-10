import Link from 'next/link'
import type { Draft } from '@/modules/unified-inbox/lib/types'
import { formatFull, formatWhen, inboxHref } from '@/modules/unified-inbox/lib/list'
import { draftBodyText, draftSubjectLabel } from '@/modules/unified-inbox/lib/drafts'
import { scheduleLabel } from '@/modules/unified-inbox/lib/scheduled'
import { MessageText } from './MessageText'
import { SendDraftForColleague } from './SendDraftForColleague'
import { PaperclipIcon } from './icons'

// A colleague's half-written message: read it, and - if you may send from their
// address - send it out for them as it stands.
//
// It exists because a Drafts folder that only listed subjects would answer half
// the question somebody covering an address actually has. "Sam has started
// something to the Hendersons" is worth knowing; whether it already says the
// thing you were about to say is the reason you looked.
//
// There is still no writing box, and that is the whole shape of the screen: the
// two things a coverer may do with somebody's unfinished reply are read it and
// post it untouched. Editing it would be putting words in somebody's mouth on
// an address that signs as them, and canEditDraft in lib/drafts.ts still answers
// "only the author" - what moved is sending, which is canSendDraftForOwner.
//
// The button is drawn only when the server would actually let it through. An
// offer that ends in "you do not have permission" is worse than no offer, so
// `canSend` is the answer canReplyToInbox already gave the panel, and the route
// asks the same question again for itself.
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
  /** And its id, which goes back to the server with a send: both halves of the
   *  question - whose draft, which address - are answered against the address
   *  the panel resolved rather than against anything on the draft row (E17). */
  inboxId: string
  /** Whether this reader may send from the address it is filed on, which is the
   *  whole of whether they may send it out for its author. Settled by the panel
   *  from the addresses this person may SEND from, and asked again by the route
   *  before anything leaves. */
  canSend: boolean
  now: Date
  timezone: string
}

export function DraftReadView({
  base, params, draft, ownerName, inboxName, inboxId, canSend, now, timezone,
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

      {/* At the foot rather than the head: somebody came here to read the words
          first. The sentence beside the button says what pressing it does NOT
          do - it does not hand over the writing - because a Send on somebody
          else's draft is otherwise easy to read as "open it and finish it". */}
      <div className="uin-draft-read-foot">
        {canSend ? (
          <>
            <p className="uin-draft-read-note">
              It is {ownerName}&apos;s writing, so only they can change it. You can send it out for
              them exactly as it stands.
            </p>
            <div className="uin-draft-read-actions">
              <SendDraftForColleague
                draftId={draft.id}
                inboxId={inboxId}
                ownerName={ownerName}
              />
            </div>
          </>
        ) : (
          <p className="uin-draft-read-note">
            This is {ownerName}&apos;s writing, so it is here to read only. Only they can finish it
            or send it.
          </p>
        )}
      </div>
    </div>
  )
}
