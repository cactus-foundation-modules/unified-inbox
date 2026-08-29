import type { Draft } from '@/modules/unified-inbox/lib/types'
import { formatWhen, initialsFor } from '@/modules/unified-inbox/lib/list'
import {
  draftHref,
  draftPreview,
  draftRecipientLabel,
  draftSubjectLabel,
} from '@/modules/unified-inbox/lib/drafts'
import { PaperclipIcon } from './icons'

// The Drafts list: what this person started and has not sent.
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
  now: Date
}

export function DraftListView({
  base, params, drafts, inboxNames, openThreadId, openDraftId, now,
}: Props) {
  if (drafts.length === 0) {
    return (
      <div className="uin-empty">
        <strong>Nothing put down half-written</strong>
        Anything you start and save rather than send waits here until you come back to it.
      </div>
    )
  }

  return (
    <ul className="uin-list">
      {drafts.map((draft) => {
        const who = draftRecipientLabel(draft)
        const open = draft.threadId
          ? draft.threadId === openThreadId
          : draft.id === openDraftId
        const inboxName = draft.inboxId ? inboxNames[draft.inboxId] : null
        return (
          <li key={draft.id}>
            <a
              className="uin-row"
              href={draftHref(base, params, draft)}
              aria-current={open ? 'true' : undefined}
            >
              <span className="uin-avatar-wrap">
                <span className="uin-avatar" aria-hidden="true">{initialsFor(who)}</span>
              </span>
              <span className="uin-row-main">
                <span className="uin-row-who">
                  <span className="uin-row-name">{who}</span>
                </span>
                <span className="uin-row-subject">{draftSubjectLabel(draft)}</span>
                <span className="uin-row-preview">
                  {draft.body.trim() ? draftPreview(draft.body) : ''}
                </span>
              </span>
              <span className="uin-row-meta">
                <span className="uin-row-tags">
                  {draft.attachments.length > 0 && (
                    <span className="uin-tag" title="Has an attachment">
                      {PaperclipIcon}<span className="sr-only">Has an attachment</span>
                    </span>
                  )}
                  {draft.threadId && <span className="uin-tag">Reply</span>}
                  {inboxName && <span className="uin-tag">{inboxName}</span>}
                </span>
                <span>{formatWhen(draft.updatedAt, now)}</span>
              </span>
            </a>
          </li>
        )
      })}
    </ul>
  )
}
