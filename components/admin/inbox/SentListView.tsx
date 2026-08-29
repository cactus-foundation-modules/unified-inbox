import type { SentMessageRow } from '@/modules/unified-inbox/lib/db'
import {
  formatWhen,
  inboxHref,
  initialsFor,
  pageCount,
  PER_PAGE,
} from '@/modules/unified-inbox/lib/list'
import { PaperclipIcon, TickIcon } from './icons'

// Everything that has left, newest first, across every address this person can
// read.
//
// One row per message rather than per conversation: a thread somebody has
// answered four times is four things sent, and "did that quote actually go, and
// when" is a question about the message, not about the conversation it sits in.
// Opening a row opens the conversation it belongs to, which is where the answer
// to it will arrive.
//
// What became of it rides on the row where the site is watching for that -
// delivered, opened, or never arrived at all. On a site with receipts switched
// off every one of those is empty and the row simply says when it went.

type Props = {
  base: string
  params: Record<string, string>
  rows: SentMessageRow[]
  total: number
  page: number
  openThreadId: string | null
  /** What each address is called, for the tag on a row. Ids mean nothing to
   *  anybody reading a list. */
  inboxNames: Record<string, string>
  staffById: Record<string, string>
  now: Date
}

/** Who it went to, in as few characters as tell the truth. */
function recipientLabel(row: SentMessageRow): string {
  const first = row.toAddresses[0]?.trim()
  if (!first) return 'Nobody recorded'
  if (row.toAddresses.length > 1) return `${first} and ${row.toAddresses.length - 1} more`
  return first
}

export function SentListView({
  base, params, rows, total, page, openThreadId, inboxNames, staffById, now,
}: Props) {
  const pages = pageCount(total, PER_PAGE)

  if (rows.length === 0) {
    return (
      <div className="uin-empty">
        <strong>Nothing has gone out yet</strong>
        Every reply and every message written here turns up in this list once it has left, with
        what became of it beside it.
      </div>
    )
  }

  return (
    <>
      <ul className="uin-list">
        {rows.map((row) => {
          const who = recipientLabel(row)
          const author = row.authorUserId ? staffById[row.authorUserId] : null
          const inboxName = row.inboxId ? inboxNames[row.inboxId] : null
          const hardBounce = row.bouncedAt
            && ['hard', 'blocked', 'invalid', 'spam', 'error'].includes(row.bounceKind ?? '')
          return (
            <li key={row.id}>
              <a
                className="uin-row"
                href={inboxHref(base, params, { id: row.threadId })}
                aria-current={row.threadId === openThreadId ? 'true' : undefined}
              >
                <span className="uin-avatar-wrap">
                  <span className="uin-avatar" aria-hidden="true">{initialsFor(who)}</span>
                </span>
                <span className="uin-row-main">
                  <span className="uin-row-who">
                    <span className="uin-row-name">To {who}</span>
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
                    {row.deliveryStatus === 'sending' && <span className="uin-tag">On its way</span>}
                    {row.deliveryStatus === 'failed' && (
                      <span className="uin-tag uin-tag-failed">It did not send</span>
                    )}
                    {hardBounce && <span className="uin-tag uin-tag-failed">It did not arrive</span>}
                    {!hardBounce && row.openedAt && (
                      <span className="uin-tag uin-tag-done">
                        {TickIcon} Opened
                      </span>
                    )}
                    {author && <span className="uin-tag">{author}</span>}
                    {inboxName && <span className="uin-tag">{inboxName}</span>}
                  </span>
                  <span>{formatWhen(row.sentAt, now)}</span>
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
