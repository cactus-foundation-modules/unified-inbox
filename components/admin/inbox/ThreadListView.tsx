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
import { ChatIcon, FormIcon, PaperclipIcon, PhoneIcon } from './icons'

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
  /** True when nothing has ever been collected, which is a different problem
   *  from a filter that matches nothing. */
  neverSynced: boolean
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
  base, params, rows, total, page, openThreadId, staffById, neverSynced, searching, now,
}: Props) {
  const pages = pageCount(total, PER_PAGE)

  if (rows.length === 0) {
    return (
      <div className="uin-empty">
        {neverSynced ? (
          <>
            <strong>Nothing has been collected yet</strong>
            The first collection runs on the site&rsquo;s hourly round. There is a
            &ldquo;Check now&rdquo; button in Settings &rsaquo; Unified Inbox if you would rather
            not wait.
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
          const open = row.id === openThreadId
          const assignee = row.assigneeUserId ? staffById[row.assigneeUserId] : null
          return (
            <li key={row.id}>
              <a
                className={`uin-row${row.unread ? ' uin-row-unread' : ''}`}
                href={inboxHref(base, params, { id: row.id })}
                aria-current={open ? 'true' : undefined}
              >
                <span className="uin-avatar-wrap">
                  <span className="uin-avatar" aria-hidden="true">{initialsFor(who)}</span>
                  <ChannelBadge channel={row.channel} />
                </span>
                <span className="uin-row-main">
                  <span className="uin-row-who">
                    {row.unread && <span className="uin-row-dot" aria-hidden="true" />}
                    <span className={`uin-row-name${row.unread ? ' uin-row-name-unread' : ''}`}>{who}</span>
                    {row.unread && <span className="sr-only">(unread)</span>}
                  </span>
                  <span className="uin-row-subject">{row.subject || '(no subject)'}</span>
                  <span className="uin-row-preview">{row.preview || ''}</span>
                </span>
                <span className="uin-row-meta">
                  <span className="uin-row-tags">
                    {row.hasAttachments && (
                      <span className="uin-tag" title="Has an attachment">
                        {PaperclipIcon}<span className="sr-only">Has an attachment</span>
                      </span>
                    )}
                    {row.status === 'done' && <span className="uin-tag uin-tag-done">Done</span>}
                    {row.status === 'snoozed' && <span className="uin-tag uin-tag-snoozed">Snoozed</span>}
                    {assignee && <span className="uin-tag">{assignee}</span>}
                  </span>
                  <span>{formatWhen(row.lastMessageAt, now)}</span>
                </span>
              </a>
            </li>
          )
        })}
      </ul>

      {pages > 1 && (
        <div className="uin-pager">
          {page > 1 ? (
            <a className="btn btn-secondary btn-sm" href={inboxHref(base, params, { page: String(page - 1), id: null })}>
              Newer
            </a>
          ) : <span />}
          <span>Page {page} of {pages}</span>
          {page < pages ? (
            <a className="btn btn-secondary btn-sm" href={inboxHref(base, params, { page: String(page + 1), id: null })}>
              Older
            </a>
          ) : <span />}
        </div>
      )}
    </>
  )
}
