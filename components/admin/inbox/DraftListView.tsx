import Link from 'next/link'
import type { Draft } from '@/modules/unified-inbox/lib/types'
import { formatWhen, initialsFor } from '@/modules/unified-inbox/lib/list'
import {
  draftHref,
  draftPreview,
  draftRecipientLabel,
  draftSubjectLabel,
} from '@/modules/unified-inbox/lib/drafts'
import { PaperclipIcon, PenIcon } from './icons'

// The Drafts list: what anybody has started on an address you can read, and
// has not sent.
//
// It takes the list pane's place rather than sitting somewhere else on the
// screen, because it answers the same question the conversation list answers -
// what is in front of me - and a second list in a third column would be a third
// place to look for one thing.
//
// No filters above it and no pages under it. Drafts are counted in tens at
// worst, and a status filter over messages that have no status would be
// furniture rather than a control.

type Props = {
  base: string
  params: Record<string, string>
  drafts: Draft[]
  /** What each address is called, for the tag on a row. Ids mean nothing to
   *  anybody reading a list. */
  inboxNames: Record<string, string>
  openThreadId: string | null
  openDraftId: string | null
  /** Who each colleague is, for the tag on somebody else's row. */
  staffById: Record<string, string>
  /** So a row can say whose it is only when it is not the reader's own - a
   *  badge on every row marks nothing. */
  currentUserId: string
  now: Date
}

export function DraftListView({
  base, params, drafts, inboxNames, openThreadId, openDraftId, staffById, currentUserId, now,
}: Props) {
  if (drafts.length === 0) {
    return (
      <div className="uin-empty">
        <strong>Nothing put down half-written</strong>
        Anything anybody starts and saves rather than sends waits here until somebody comes
        back to it.
      </div>
    )
  }

  return (
    <ul className="uin-list">
      {drafts.map((draft) => {
        const who = draftRecipientLabel(draft)
        // "No recipient yet" and "A reply" are sentences standing in for an
        // address nobody has typed yet. Initials taken off the first of them put
        // NR in a circle, which reads as a draft to somebody of that name.
        const addressed = draft.to.length > 0
        const open = draft.threadId
          ? draft.threadId === openThreadId
          : draft.id === openDraftId
        const inboxName = draft.inboxId ? inboxNames[draft.inboxId] : null
        return (
          <li key={draft.id}>
            <Link
              className="uin-row"
              href={draftHref(base, params, draft)}
              aria-current={open ? 'true' : undefined}
            >
              <span className="uin-avatar-wrap">
                <span className="uin-avatar" aria-hidden="true">
                  {addressed ? initialsFor(who) : PenIcon}
                </span>
              </span>
              <span className="uin-row-main">
                <span className="uin-row-who">
                  <span className="uin-row-name">{who}</span>
                </span>
                <span className="uin-row-subject">{draftSubjectLabel(draft)}</span>
                {/* Nothing rather than an empty line: a blank preview left a gap
                    under every draft that has none. */}
                {draft.body.trim() && (
                  <span className="uin-row-preview">{draftPreview(draft.body)}</span>
                )}
              </span>
              <span className="uin-row-meta">
                <span className="uin-row-tags">
                  {draft.attachments.length > 0 && (
                    <span className="uin-tag" title="Has an attachment">
                      {PaperclipIcon}<span className="sr-only">Has an attachment</span>
                    </span>
                  )}
                  {/* The words go in a span of their own so a long name ends in an
                      ellipsis rather than being cut off mid-letter. */}
                  {draft.authorUserId !== currentUserId && (
                    <span className="uin-tag">
                      <span className="uin-tag-text">
                        {staffById[draft.authorUserId] ?? 'Somebody else'}
                      </span>
                    </span>
                  )}
                  {draft.threadId && <span className="uin-tag"><span className="uin-tag-text">Reply</span></span>}
                  {inboxName && (
                    <span className="uin-tag"><span className="uin-tag-text">{inboxName}</span></span>
                  )}
                </span>
                <span>{formatWhen(draft.updatedAt, now)}</span>
              </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
