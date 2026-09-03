'use client'

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
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
//
// A client component for one reason: the tick boxes down the left. Working
// through a morning's post one conversation at a time - open it, mark it done,
// open the next - is four presses per message when three of them say the same
// thing. Ticking six and pressing Mark as done once is the whole point of a
// list. Everything else here is still plain markup and plain links.

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
  /** The site's timezone, handed down by the server-rendered panel so this
   *  list and the thread beside it never disagree about what time it is. */
  timezone: string
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
  base, params, rows, total, page, openThreadId, staffById, neverSynced, canManage, searching, now, timezone,
}: Props) {
  const router = useRouter()
  const pages = pageCount(total, PER_PAGE)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Anything ticked on a page that has since been replaced - by a filter, a
  // search or the next page - is not on the screen any more, and acting on it
  // would be acting on something nobody can see.
  const onScreen = useMemo(() => new Set(rows.map((r) => r.id)), [rows])
  const picked = useMemo(() => selected.filter((id) => onScreen.has(id)), [selected, onScreen])
  const allPicked = rows.length > 0 && picked.length === rows.length

  const toggle = useCallback((id: string) => {
    setSelected((current) => current.includes(id) ? current.filter((x) => x !== id) : [...current, id])
  }, [])

  /** One request per conversation rather than a bulk endpoint: the thread PATCH
   *  already exists, already checks who may touch which inbox, and six of them
   *  in parallel is not the thing that will slow this screen down. Settled
   *  rather than raced, so one refusal does not hide five successes. */
  const applyToPicked = useCallback(async (body: Record<string, unknown>) => {
    if (picked.length === 0) return
    setBusy(true)
    setError('')
    try {
      const results = await Promise.allSettled(picked.map((id) =>
        fetch(`/api/m/unified-inbox/threads/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then((r) => { if (!r.ok) throw new Error('refused') })
      ))
      const failed = results.filter((r) => r.status === 'rejected').length
      if (failed > 0) {
        setError(failed === picked.length
          ? 'None of those could be changed.'
          : `${failed} of ${picked.length} could not be changed. The rest were.`)
      }
      setSelected([])
      router.refresh()
    } finally {
      setBusy(false)
    }
  }, [picked, router])

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
      {picked.length > 0 && (
        <div className="uin-bulk">
          <span className="uin-bulk-count">
            {picked.length} selected
          </span>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                  onClick={() => void applyToPicked({ status: 'done' })}>
            Mark as done
          </button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                  onClick={() => void applyToPicked({ unread: false })}>
            Mark as read
          </button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                  onClick={() => void applyToPicked({ unread: true })}>
            Mark as unread
          </button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                  onClick={() => void applyToPicked({ status: 'open' })}>
            Open again
          </button>
          <button type="button" className="uin-chip" disabled={busy} onClick={() => setSelected([])}>
            Clear
          </button>
        </div>
      )}

      {error && <div className="alert alert-danger" role="alert" style={{ margin: '0.5rem 0.75rem' }}>{error}</div>}

      <div className="uin-bulk uin-bulk-all">
        <label className="uin-pick-all">
          <input
            type="checkbox"
            checked={allPicked}
            // Ticked none of them, ticked some of them, ticked the lot: the box
            // says which without anybody having to count the rows.
            ref={(el) => { if (el) el.indeterminate = picked.length > 0 && !allPicked }}
            onChange={() => setSelected(allPicked ? [] : rows.map((r) => r.id))}
          />
          Select everything on this page
        </label>
      </div>

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
          const ticked = picked.includes(row.id)
          return (
            <li key={row.id} className="uin-list-item" data-selected={ticked ? 'true' : undefined}>
              {/* Beside the link rather than inside it: a tick box inside a link
                  is a tick box you cannot press without opening the thing. */}
              <label className="uin-pick">
                <input type="checkbox" checked={ticked} onChange={() => toggle(row.id)} />
                <span className="sr-only">Select this conversation</span>
              </label>
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
                  <span>{formatWhen(row.lastMessageAt, now, timezone)}</span>
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
