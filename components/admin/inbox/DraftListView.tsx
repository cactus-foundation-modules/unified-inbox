import Link from 'next/link'
import type { Draft } from '@/modules/unified-inbox/lib/types'
import { formatFull, formatWhen, initialsFor } from '@/modules/unified-inbox/lib/list'
import {
  draftBodyText,
  draftHref,
  draftPreview,
  draftRecipientLabel,
  draftSubjectLabel,
} from '@/modules/unified-inbox/lib/drafts'
import { scheduleLabel } from '@/modules/unified-inbox/lib/scheduled'
import { PaperclipIcon, PenIcon } from './icons'

// The Drafts list: what you have started and not sent - and, with `scheduled`
// on, the Scheduled list, which is the same rows drawn the same way, filtered
// the other side of the line. One component for both because a scheduled
// message IS a draft with a departure time (see migrations/021), and two lists
// that differ by one sentence are one list that gets fixed twice.
//
// Yours only. A draft belongs to whoever wrote it (see lib/drafts.ts), so there
// is no row here to put somebody else's name on, and no need for one.
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
  /** Whether this is the Scheduled folder rather than Drafts. The rows are the
   *  same rows drawn the same way - a scheduled message IS a draft with a
   *  departure time - so the flag decides only what an empty one says, which is
   *  the one sentence the two folders cannot share. */
  scheduled?: boolean
  /** What each address is called, for the tag on a row. Ids mean nothing to
   *  anybody reading a list. */
  inboxNames: Record<string, string>
  openThreadId: string | null
  openDraftId: string | null
  now: Date
  timezone: string
}

export function DraftListView({
  base, params, drafts, scheduled, inboxNames, openThreadId, openDraftId, now, timezone,
}: Props) {
  if (drafts.length === 0) {
    return scheduled ? (
      <div className="uin-empty">
        <strong>Nothing waiting to go out</strong>
        Anything you set to send later waits here until its time comes. You can still change it,
        move it, or send it on the spot.
      </div>
    ) : (
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
        // When it goes out, or what went wrong when it tried. Drawn in both
        // folders: under Scheduled it is the whole point of the row, and under
        // Drafts it is what a message whose send was refused has to say for
        // itself - that one is no longer going anywhere on its own, so it is
        // here rather than next door.
        const going = scheduleLabel(draft, now, timezone)
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
                {/* The words rather than the markup: a body written in the
                    new box is HTML, and a row reading "<p>Dear Marcus" is a row
                    that has given up. It goes into the page as TEXT either
                    way. */}
                {draftBodyText(draft).trim() && (
                  <span className="uin-row-preview">{draftPreview(draftBodyText(draft))}</span>
                )}
              </span>
              <span className="uin-row-meta">
                <span className="uin-row-tags">
                  {going && (
                    <span
                      // The same two grounds the conversation list already
                      // uses for "waiting" and "went wrong", so a scheduled
                      // message reads the way a snoozed conversation does and
                      // a failed one reads the way a failed send does.
                      className={draft.sendState === 'failed' ? 'uin-tag uin-tag-failed' : 'uin-tag uin-tag-snoozed'}
                      title={draft.sendError ?? undefined}
                    >
                      <span className="uin-tag-text">{going}</span>
                    </span>
                  )}
                  {draft.attachments.length > 0 && (
                    <span className="uin-tag" title="Has an attachment">
                      {PaperclipIcon}<span className="sr-only">Has an attachment</span>
                    </span>
                  )}
                  {draft.threadId && <span className="uin-tag"><span className="uin-tag-text">Reply</span></span>}
                  {inboxName && (
                    <span className="uin-tag"><span className="uin-tag-text">{inboxName}</span></span>
                  )}
                </span>
                <span title={formatFull(draft.updatedAt, timezone)}>
                  {formatWhen(draft.updatedAt, now, timezone)}
                </span>
              </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
