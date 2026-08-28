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
import { PaperclipIcon } from './icons'

// The list of conversations. Every state it can be in - filtered to nothing,
// searched for something that is not there, an inbox that has never collected
// anything - says which one it is, because "no conversations" in front of
// somebody who has just set the whole thing up is a bug report waiting to
// happen rather than an answer.

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
            Everything in this view has been dealt with. Try &ldquo;All&rdquo; above if you are
            looking for something you have already closed.
          </>
        )}
      </div>
    )
  }

  return (
    <>
      <ul className="uin-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
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
                <span className="uin-avatar" aria-hidden="true">{initialsFor(who)}</span>
                <span className="uin-row-main">
                  <span className="uin-row-who">
                    <span className={`uin-row-name${row.unread ? ' uin-row-name-unread' : ''}`}>{who}</span>
                    {row.unread && <span className="sr-only">(unread)</span>}
                  </span>
                  <span className="uin-row-subject">{row.subject || '(no subject)'}</span>
                  {row.preview && <span className="uin-row-preview">{row.preview}</span>}
                </span>
                <span className="uin-row-meta">
                  <span>{formatWhen(row.lastMessageAt, now)}</span>
                  <span style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {row.hasAttachments && (
                      <span className="uin-tag" title="Has an attachment">
                        {PaperclipIcon}<span className="sr-only">Has an attachment</span>
                      </span>
                    )}
                    {row.channel !== 'email' && <span className="uin-tag">{channelLabel(row.channel)}</span>}
                    {row.status === 'done' && <span className="uin-tag uin-tag-done">Done</span>}
                    {row.status === 'snoozed' && <span className="uin-tag uin-tag-snoozed">Snoozed</span>}
                    {assignee && <span className="uin-tag">{assignee}</span>}
                  </span>
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
