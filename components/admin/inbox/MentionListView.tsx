import Link from 'next/link'
import type { MentionRow } from '@/modules/unified-inbox/lib/db'
import { channelLabel, formatWhen, inboxHref, initialsFor, pageCount, PER_PAGE } from '@/modules/unified-inbox/lib/list'
import { AtIcon, InboundIcon } from './icons'
import { Avatar } from './Avatar'
import { MentionActions } from './MentionActions'

// Everything colleagues have tagged somebody in.
//
// It reads like the conversation list beside it on purpose - same rows, same
// circle, same date at the end - because it is the same post seen from a
// different angle: not "what has arrived in accounts@" but "what has somebody
// put my name on".
//
// TWO THINGS ARE DIFFERENT, and both matter.
//
// What the row leads with is the ASK rather than the message. Who wanted you
// and what they said is why the row is here at all; the customer's own subject
// is underneath it, where the preview would be. A list that led with the
// subject would be the inbox again, and there would be no reason to have it.
//
// The controls on the right settle THIS PERSON's ask and nothing else. The
// conversation has one status shared by everybody who can read it; this has one
// per person, so three colleagues asked about the same order each work through
// their own copy and none of them clears it from under the others.

type Props = {
  base: string
  params: Record<string, string>
  rows: MentionRow[]
  total: number
  page: number
  openThreadId: string | null
  /** Names for the ids on the rows, so "Marcus asked you" is a name rather than
   *  a string of characters nobody recognises. */
  staffById: Record<string, string>
  inboxNames: Record<string, string>
  /** Which of the four tabs is on, so the empty state can say the right thing:
   *  an empty "Done" is not the same news as an empty "To do". */
  status: string
  /** Whose list this is, when it is not the reader's own - a colleague whose
   *  address they have been let in to. Null on their own, which is the case
   *  that says "you". */
  ownerName?: string | null
  /** Whether the reader may put these where they want them. Off on somebody
   *  else's: an ask is one person's own piece of work, the route settles it by
   *  user id whatever a screen decided, and a control that would be refused is
   *  worse than no control at all. */
  canSettle?: boolean
  now: Date
  timezone: string
}

export function MentionListView({
  base, params, rows, total, page, openThreadId, staffById, inboxNames, status,
  ownerName = null, canSettle = true, now, timezone,
}: Props) {
  const pages = pageCount(total, PER_PAGE)
  /** Who the row is about, in the words the sentence needs. */
  const them = ownerName ?? 'you'

  if (rows.length === 0 && ownerName) {
    // A colleague's own, where none of the four states is news the reader can
    // do anything about - so it says what the list is and stops.
    return (
      <div className="uin-empty">
        <strong>Nothing here</strong>
        {status === 'all'
          ? `Nobody has tagged ${ownerName} in a conversation on this address.`
          : `Nothing on this address that ${ownerName} has been tagged in is in that state.`}
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="uin-empty">
        {status === 'done' ? (
          <>
            <strong>Nothing finished yet</strong>
            Anything you mark done is kept here, in case you need to pick it up again.
          </>
        ) : status === 'snoozed' ? (
          <>
            <strong>Nothing set aside</strong>
            Something you have been asked about can be put off until a day and time that suits.
            It comes back here on its own.
          </>
        ) : status === 'all' ? (
          <>
            <strong>Nobody has asked you about anything</strong>
            When a colleague tags you in an internal note, it lands here - and so does the
            conversation it was about, whether or not that inbox is one of yours.
          </>
        ) : (
          <>
            <strong>Nothing waiting on you</strong>
            Everything colleagues have asked you about has been dealt with. Try
            &ldquo;All&rdquo; above if you are looking for something you have already finished.
          </>
        )}
      </div>
    )
  }

  return (
    <>
      <ul className="uin-list">
        {rows.map((row) => {
          const asker = row.byUserId ? staffById[row.byUserId] ?? null : null
          const named = (row.participantName ?? row.participantAddress ?? '').trim() || null
          const open = row.threadId === openThreadId
          const where = row.inboxId ? inboxNames[row.inboxId] ?? null : null
          return (
            <li key={row.id} className="uin-list-item uin-ask-item">
              <Link
                className={`uin-row${row.status === 'open' ? ' uin-row-unread' : ''}`}
                href={inboxHref(base, params, { id: row.threadId })}
                aria-current={open ? 'true' : undefined}
              >
                <Avatar
                  /* Never a picture: the circle here stands for whoever the
                     conversation is with, and this list is opened to see who
                     wanted YOU. Initials keep the rows the same height as the
                     inbox's without a second thing to look at. */
                  src={null}
                  title={named ?? undefined}
                >
                  {named ? initialsFor(named) : InboundIcon}
                </Avatar>
                <span className="uin-row-main">
                  <span className="uin-row-who">
                    {row.status === 'open' && <span className="uin-row-dot" aria-hidden="true" />}
                    <span className={`uin-row-name${row.status === 'open' ? ' uin-row-name-unread' : ''}`}>
                      {asker
                        ? `${asker} asked ${them}`
                        : ownerName ? `${ownerName} was asked` : 'You were asked'}
                    </span>
                    {where && (
                      <>
                        <span className="uin-row-arrow" aria-hidden="true">&rsaquo;</span>
                        <span className="uin-row-to">{where}</span>
                      </>
                    )}
                  </span>
                  {/* What they actually said, in their own words. The whole
                      reason somebody opens this list rather than their inbox. */}
                  {row.note && <span className="uin-row-subject uin-ask-note">{row.note}</span>}
                  <span className="uin-row-preview">
                    <span className="uin-ask-about">{AtIcon}</span>
                    {row.subject || `(no subject)`}
                    <span className="uin-ask-channel"> &middot; {channelLabel(row.channel)}</span>
                  </span>
                </span>
                <span className="uin-row-meta">
                  <span className="uin-row-tags">
                    {row.status === 'done' && (
                      <span className="uin-tag uin-tag-done"><span className="uin-tag-text">Done</span></span>
                    )}
                    {row.status === 'snoozed' && row.snoozeUntil && (
                      <span className="uin-tag uin-tag-snoozed">
                        <span className="uin-tag-text">Back {formatWhen(row.snoozeUntil, now, timezone)}</span>
                      </span>
                    )}
                  </span>
                  <span>{formatWhen(row.createdAt, now, timezone)}</span>
                </span>
              </Link>
              {/* Outside the link, for the same reason the tick boxes in the
                  conversation list are: a control inside a link is a control you
                  cannot press without opening the thing behind it. */}
              {canSettle && (
                <MentionActions mentionId={row.id} status={row.status} timezone={timezone} />
              )}
            </li>
          )
        })}
      </ul>

      {pages > 1 && (
        <div className="uin-pager">
          {page > 1 ? (
            <Link className="btn btn-secondary btn-sm" href={inboxHref(base, params, { page: String(page - 1), id: null })}>
              Newer
            </Link>
          ) : <span />}
          <span>Page {page} of {pages}</span>
          {page < pages ? (
            <Link className="btn btn-secondary btn-sm" href={inboxHref(base, params, { page: String(page + 1), id: null })}>
              Older
            </Link>
          ) : <span />}
        </div>
      )}
    </>
  )
}
