import Link from 'next/link'
import type { ThreadListRow } from '@/modules/unified-inbox/lib/db'
import {
  channelLabel,
  formatWhen,
  inboxHref,
  initialsFor,
  pageCount,
  participantLabel,
  PER_PAGE,
} from '@/modules/unified-inbox/lib/list'
import { ChatIcon, FormIcon, InboundIcon, PaperclipIcon, PhoneIcon } from './icons'

// The list of conversations. Every state it can be in - filtered to nothing,
// searched for something that is not there, an inbox that has never collected
// anything - says which one it is, because "no conversations" in front of
// somebody who has just set the whole thing up is a bug report waiting to
// happen rather than an answer.
//
// A row lays itself out by how much room the list has been given rather than by
// how wide the window is (see the container query in styles.tsx): across in one
// line when the list is the whole screen, stacked when it is a column beside an
// open conversation. Same markup either way.

type Props = {
  base: string
  params: Record<string, string>
  rows: ThreadListRow[]
  total: number
  page: number
  openThreadId: string | null
  staffById: Record<string, string>
  /** True when nothing has ever been collected AND this list is one that mail
   *  collection would fill, which is a different problem from a filter that
   *  matches nothing. */
  neverSynced: boolean
  /** Whether this reader may open the settings the empty state would otherwise
   *  send them to. Being told where a button is on a screen you are not allowed
   *  to open is worse than not being told. */
  canManage: boolean
  searching: boolean
  now: Date
}

const CHANNEL_ICONS: Record<string, React.ReactNode> = {
  chat: ChatIcon,
  form: FormIcon,
  phone: PhoneIcon,
  sms: PhoneIcon,
}

/** How a conversation arrived, on the corner of the circle. Email is the ordinary
 *  case and wears no badge - a mark against every row marks nothing. */
function ChannelBadge({ channel }: { channel: string }) {
  const icon = CHANNEL_ICONS[channel]
  if (!icon) return null
  return (
    <span className="uin-avatar-badge">
      {icon}
      <span className="sr-only">{channelLabel(channel)}</span>
    </span>
  )
}

export function ThreadListView({
  base, params, rows, total, page, openThreadId, staffById, neverSynced, canManage, searching, now,
}: Props) {
  const pages = pageCount(total, PER_PAGE)

  if (rows.length === 0) {
    return (
      <div className="uin-empty">
        {neverSynced ? (
          <>
            <strong>Nothing has been collected yet</strong>
            The first collection runs on the site&rsquo;s hourly round.
            {canManage && (
              <> There is a &ldquo;Check now&rdquo; button in Settings &rsaquo; Unified Inbox if
              you would rather not wait.</>
            )}
          </>
        ) : searching ? (
          <>
            <strong>Nothing matches that</strong>
            Try fewer words, or clear the search to see everything again.
          </>
        ) : (
          <>
            <strong>Nothing here</strong>
            Everything in this view has been dealt with. Try &ldquo;Everything&rdquo; above if you
            are looking for something you have already closed.
          </>
        )}
      </div>
    )
  }

  return (
    <>
      <ul className="uin-list">
        {rows.map((row) => {
          const who = participantLabel(row)
          // Whether there is a human here to take initials off, asked separately
          // from what the row says. "Unknown sender" is a sentence standing in
          // for a name nobody recorded, and initials taken off it put US in a
          // circle as though somebody of that name had written in.
          const named = (row.participantName ?? row.participantAddress ?? '').trim() || null
          const open = row.id === openThreadId
          const assignee = row.assigneeUserId ? staffById[row.assigneeUserId] : null
          return (
            <li key={row.id}>
              <Link
                className={`uin-row${row.unread ? ' uin-row-unread' : ''}`}
                href={inboxHref(base, params, { id: row.id })}
                aria-current={open ? 'true' : undefined}
              >
                <span className="uin-avatar-wrap">
                  <span className="uin-avatar" aria-hidden="true">
                    {named ? initialsFor(named) : InboundIcon}
                  </span>
                  <ChannelBadge channel={row.channel} />
                </span>
                <span className="uin-row-main">
                  <span className="uin-row-who">
                    {row.unread && <span className="uin-row-dot" aria-hidden="true" />}
                    <span className={`uin-row-name${row.unread ? ' uin-row-name-unread' : ''}`}>{who}</span>
                    {row.unread && <span className="sr-only">(unread)</span>}
                  </span>
                  <span className="uin-row-subject">{row.subject || '(no subject)'}</span>
                  {/* Nothing rather than an empty line: a blank preview left a gap
                      under every subject that has none. */}
                  {row.preview && <span className="uin-row-preview">{row.preview}</span>}
                </span>
                <span className="uin-row-meta">
                  <span className="uin-row-tags">
                    {row.hasAttachments && (
                      <span className="uin-tag" title="Has an attachment">
                        {PaperclipIcon}<span className="sr-only">Has an attachment</span>
                      </span>
                    )}
                    {row.status === 'done' && (
                      <span className="uin-tag uin-tag-done"><span className="uin-tag-text">Done</span></span>
                    )}
                    {row.status === 'snoozed' && (
                      <span className="uin-tag uin-tag-snoozed"><span className="uin-tag-text">Snoozed</span></span>
                    )}
                    {/* The words go in a span of their own so a long name ends in
                        an ellipsis rather than being cut off mid-letter: the badge
                        itself is a flex box, and text-overflow does nothing to
                        one of those. */}
                    {assignee && <span className="uin-tag"><span className="uin-tag-text">{assignee}</span></span>}
                  </span>
                  <span>{formatWhen(row.lastMessageAt, now)}</span>
                </span>
              </Link>
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
