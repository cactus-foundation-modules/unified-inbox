'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { ThreadListRow } from '@/modules/unified-inbox/lib/db'
import {
  avatarHref,
  channelLabel,
  discussionFrom,
  discussionTo,
  formatFull,
  formatWhen,
  inboxHref,
  initialsFor,
  pageCount,
  participantLabel,
  PER_PAGE,
} from '@/modules/unified-inbox/lib/list'
import { pickWinner, widenedAccessWarning } from '@/modules/unified-inbox/lib/thread-merge'
import { ChatIcon, FormIcon, InboundIcon, NoteIcon, PaperclipIcon, PhoneIcon, ReplyIcon, TickIcon } from './icons'
import { Avatar } from './Avatar'
import { ConfirmDialog } from './ConfirmDialog'

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
// A client component for one reason: picking several conversations at once.
// Working through a morning's post one at a time - open it, mark it done, open
// the next - is four presses per message when three of them say the same thing.
// Picking six and pressing Mark as done once is the whole point of a list.
//
// There is no tick box in front of each row to do it with. A column of them is
// a column of clutter on every row on every screen, for something that happens
// twice a week. Rows are picked the way a mail program has picked them for
// thirty years:
//
//   - a plain click opens the conversation, as it always did, and marks that
//     row as where a run would start from;
//   - shift-click picks everything between that row and this one, which is the
//     three-in-a-row case: click the top one, shift-click the third, done;
//   - cmd-click (ctrl on Windows) adds or removes one on its own;
//   - space does the same as cmd-click, for anybody on the keyboard, and
//     shift-space extends the run - the tick box's job, without the tick box.
//
// A plain click also drops whatever was picked, exactly as it does in Finder
// and in Mail: a set of rows nobody can see any more, still armed behind a
// button that says Mark as done, is a worse thing to leave lying about than a
// selection somebody has to make twice.

type Props = {
  base: string
  params: Record<string, string>
  rows: ThreadListRow[]
  total: number
  page: number
  openThreadId: string | null
  staffById: Record<string, string>
  /** Who is reading. A row's own end of a conversation is said as "Me" rather
   *  than by name: a column of rows all ending in the reader's own name tells
   *  them nothing they did not already know, and "WorldFirst > Me" is how a
   *  mail program has put it for thirty years. */
  meId: string
  /** What each inbox is called, so a row can say which of your addresses it
   *  came in on when nobody has been handed it yet. */
  inboxNames: Record<string, string>
  /** Whether to ask for people's own pictures at all. Off unless the site has
   *  switched it on - see Settings, People. */
  showAvatars: boolean
  /** True when nothing has ever been collected AND this list is one that mail
   *  collection would fill, which is a different problem from a filter that
   *  matches nothing. */
  neverSynced: boolean
  /** Whether this is the Spam folder. Only the empty state reads it, and it
   *  needs to: an empty spam folder is the good outcome, and both of the
   *  sentences below tell somebody looking at one that something is wrong. */
  spam: boolean
  /** Whose bin it is, when it is not the reader's own. Only the empty state
   *  reads it, and it needs to: "only you can see this" is a plain untruth over
   *  a colleague's folder. */
  spamOwnerName: string | null
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
  discussion: NoteIcon,
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
  base, params, rows, total, page, openThreadId, staffById, meId, inboxNames, showAvatars,
  neverSynced, spam, spamOwnerName, canManage, searching, now, timezone,
}: Props) {
  const router = useRouter()
  const pages = pageCount(total, PER_PAGE)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [merging, setMerging] = useState(false)
  // Where a shift-clicked run is measured from: the row picked last on its own.
  // A ref rather than state - nothing on the screen draws it, so changing it
  // has no business redrawing forty rows.
  const anchorRef = useRef<number | null>(null)

  // Anything ticked on a page that has since been replaced - by a filter, a
  // search or the next page - is not on the screen any more, and acting on it
  // would be acting on something nobody can see.
  // The same staff names, with the reader's own replaced by "Me". Used for the
  // two ends a row prints and nowhere else: initials and the tooltip on the
  // circle still come off the real name, because "M" in a circle names nobody.
  const endNames = useMemo(
    () => (meId ? { ...staffById, [meId]: 'Me' } : staffById),
    [staffById, meId],
  )

  const onScreen = useMemo(() => new Set(rows.map((r) => r.id)), [rows])
  const picked = useMemo(() => selected.filter((id) => onScreen.has(id)), [selected, onScreen])
  const pickedSet = useMemo(() => new Set(picked), [picked])

  const clearPicked = useCallback(() => {
    anchorRef.current = null
    setSelected([])
  }, [])

  /** One row on or off, and the point any later run is measured from. */
  const toggle = useCallback((id: string, index: number) => {
    anchorRef.current = index
    setSelected((current) => current.includes(id) ? current.filter((x) => x !== id) : [...current, id])
  }, [])

  /** Everything from the last row picked to this one, added to whatever was
   *  already picked. Added rather than replacing: picking three at the top,
   *  then a run further down, is one job and not two. With nothing picked yet
   *  the run starts where it ends, which picks the one row pressed. */
  const extendTo = useCallback((index: number) => {
    // Nothing pressed yet this visit, but a conversation is open beside the
    // list: that is the one the reader last chose, so a run measured from it is
    // the run they mean. It survives a reload, which a ref does not.
    const openIndex = openThreadId ? rows.findIndex((r) => r.id === openThreadId) : -1
    const from = anchorRef.current ?? (openIndex >= 0 ? openIndex : index)
    const [lo, hi] = from <= index ? [from, index] : [index, from]
    const run = rows.slice(lo, hi + 1).map((r) => r.id)
    setSelected((current) => [...new Set([...current, ...run])])
  }, [rows, openThreadId])

  const onRowClick = useCallback((e: React.MouseEvent, id: string, index: number) => {
    if (e.shiftKey) {
      e.preventDefault()
      // A shift-press over text also drags a text selection across everything
      // between the two presses, which down a list of forty rows is a page of
      // blue nobody asked for.
      window.getSelection()?.removeAllRanges()
      extendTo(index)
      return
    }
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault()
      toggle(id, index)
      return
    }
    // An ordinary press on an ordinary link: let it open the conversation, and
    // remember the row it opened, because that is where the next shift-click
    // measures its run from.
    anchorRef.current = index
    setSelected([])
  }, [extendTo, toggle])

  const onRowKeyDown = useCallback((e: React.KeyboardEvent, id: string, index: number) => {
    // Space on a link does nothing at all by default, so it is free to mean
    // "pick this one" - the keyboard's way in, now the tick box has gone.
    if (e.key !== ' ') return
    e.preventDefault()
    if (e.shiftKey) extendTo(index)
    else toggle(id, index)
  }, [extendTo, toggle])

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
      clearPicked()
      router.refresh()
    } finally {
      setBusy(false)
    }
  }, [picked, router, clearPicked])

  /** What merging the picked rows would do, worked out before anybody is asked
   *  to agree to it: which conversation the rest fold into, and whether doing it
   *  would let more people read something than can read it now. */
  const mergePlan = useMemo(() => {
    if (picked.length < 2) return null
    const chosen = rows.filter((row) => picked.includes(row.id))
    const winner = pickWinner(chosen)
    if (!winner) return null
    const losers = chosen.filter((row) => row.id !== winner.id)
    const names = new Map(Object.entries(inboxNames))
    return {
      winner,
      losers,
      warning: widenedAccessWarning({ winner, losers, inboxNames: names }),
    }
  }, [picked, rows, inboxNames])

  /** One request, not one per conversation: a merge is a single transaction on
   *  the server and half a merge is not a thing anybody wants to be left with. */
  const merge = useCallback(async () => {
    if (!mergePlan) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/m/unified-inbox/threads/${mergePlan.winner.id}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loserIds: mergePlan.losers.map((row) => row.id) }),
      })
      if (!response.ok) {
        setError((await response.json().catch(() => null))?.error ?? 'They could not be merged.')
        return
      }
      setSelected([])
      router.refresh()
    } catch {
      setError('The site could not be reached, so nothing changed.')
    } finally {
      setBusy(false)
    }
  }, [mergePlan, router])

  if (rows.length === 0) {
    return (
      <div className="uin-empty">
        {spam ? (
          <>
            {/* First, ahead of everything else: an empty spam folder is not a
                problem to explain, and "nothing has been collected yet" over the
                top of one would send somebody off to check their mail account
                over nothing. */}
            <strong>Nothing in here</strong>
            {spamOwnerName ? (
              <>
                Junk thrown away out of {spamOwnerName}&rsquo;s post lands here rather than in your
                own spam folder, because it is their post. Nothing is deleted, so anything that
                ends up in here by mistake can be taken straight back out again.
              </>
            ) : (
              <>
                Junk you throw away lands in this folder, and only you can see it - marking
                something as junk changes nothing for your colleagues. Nothing is deleted, so
                anything you put in here by mistake can be taken straight back out again.
              </>
            )}
          </>
        ) : neverSynced ? (
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
            Everything in this view has been dealt with. Try &ldquo;All&rdquo; above if you
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
          {/* Two or more, because merging one conversation into itself is not a
              thing - and only for whoever set the addresses up, since a merge
              across two of them changes who can read what. */}
          {canManage && picked.length > 1 && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                    onClick={() => setMerging(true)}>
              Merge
            </button>
          )}
          <button type="button" className="uin-chip" disabled={busy} onClick={clearPicked}>
            Clear
          </button>
        </div>
      )}

      {error && <div className="alert alert-danger" role="alert" style={{ margin: '0.5rem 0.75rem' }}>{error}</div>}

      <ul className="uin-list">
        {rows.map((row, index) => {
          // A discussion is between two colleagues, so both ends of it are
          // people rather than an outsider and one of our addresses. Read off
          // the conversation itself, because every message on one is an
          // internal note and the participant join deliberately looks past
          // those - which is what used to leave "Unknown sender" against a
          // discussion somebody here plainly started.
          const startedBy = discussionFrom(row, endNames)
          const putTo = discussionTo(row, endNames)
          const who = startedBy ?? participantLabel(row)
          // Whether there is a human here to take initials off, asked separately
          // from what the row says. "Unknown sender" is a sentence standing in
          // for a name nobody recorded, and initials taken off it put US in a
          // circle as though somebody of that name had written in. Off the real
          // names, not the printed ones: a row that says "Me" still wants the
          // reader's own initials in the circle rather than an M.
          const named = discussionFrom(row, staffById)
            ?? ((row.participantName ?? row.participantAddress ?? '').trim() || null)
          const open = row.id === openThreadId
          const assignee = row.assigneeUserId ? endNames[row.assigneeUserId] : null
          // Whose desk it is on. A name once somebody has taken it, and the
          // address it arrived at until then - which on a shared inbox is the
          // more useful of the two anyway. Nothing at all on a conversation
          // that landed in no inbox and belongs to nobody.
          //
          // On a discussion it is who it was put to, ahead of both: a discussion
          // nobody has been handed would otherwise name the address it sits in,
          // which on the ordinary one is the starter's own - so the row read
          // "somebody > the same somebody".
          const otherEnd = putTo ?? assignee ?? (row.inboxId ? inboxNames[row.inboxId] ?? null : null)
          // Never the same name twice. A discussion put to nobody is a note to
          // self, and its address is its starter's own, so the two ends would
          // otherwise read "Emma > Emma" - which is what a discussion read like
          // before it had a To line to go on at all.
          const other = otherEnd === who ? null : otherEnd
          const ticked = pickedSet.has(row.id)
          return (
            <li key={row.id} className="uin-list-item" data-selected={ticked ? 'true' : undefined}>
              <Link
                className={`uin-row${row.unread ? ' uin-row-unread' : ''}`}
                href={inboxHref(base, params, { id: row.id })}
                aria-current={open ? 'true' : undefined}
                onClick={(e) => onRowClick(e, row.id, index)}
                onKeyDown={(e) => onRowKeyDown(e, row.id, index)}
              >
                {/* A picked row wears a tick where its face was. The circle is
                    already there on every row and already the right size, so
                    saying it this way costs the list no width at all. */}
                {ticked ? (
                  <span className="uin-avatar-wrap">
                    <span className="uin-avatar uin-avatar-ticked" aria-hidden="true">{TickIcon}</span>
                  </span>
                ) : (
                  <Avatar
                    src={showAvatars
                      ? avatarHref(startedBy ? 'user' : 'person', startedBy ? row.startedByUserId : row.personId)
                      : null}
                    badge={<ChannelBadge channel={row.channel} />}
                    title={named ?? undefined}
                  >
                    {named ? initialsFor(named) : InboundIcon}
                  </Avatar>
                )}
                <span className="uin-row-main">
                  <span className="uin-row-who">
                    {row.unread && <span className="uin-row-dot" aria-hidden="true" />}
                    <span className={`uin-row-name${row.unread ? ' uin-row-name-unread' : ''}`}>{who}</span>
                    {/* Who it is with at this end. A mail program shows the two
                        halves of a conversation, and on a shared address "who is
                        this one with" is the question the list is asked most:
                        whoever has been handed it, or the address it came in on
                        while nobody has. */}
                    {other && (
                      <>
                        <span className="uin-row-arrow" aria-hidden="true">&rsaquo;</span>
                        <span className="uin-row-to">{other}</span>
                      </>
                    )}
                    {row.unread && <span className="sr-only">(unread)</span>}
                    {ticked && <span className="sr-only">(selected)</span>}
                  </span>
                  <span className="uin-row-subject">{row.subject || '(no subject)'}</span>
                  {/* Nothing rather than an empty line: a blank preview left a gap
                      under every subject that has none. */}
                  {row.preview && (
                    <span className="uin-row-preview">
                      {/* The turned arrow a mail program puts against a thread
                          whose last word was ours. It answers "am I waiting on
                          them, or are they waiting on me" without opening
                          anything. */}
                      {row.lastDirection === 'out' && (
                        <span className="uin-row-replied">
                          {ReplyIcon}<span className="sr-only">You replied last.</span>
                        </span>
                      )}
                      {row.preview}
                    </span>
                  )}
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
                    {/* How many messages are in it, last so it sits hard against
                        the edge under the date. One is not worth saying. */}
                    {row.messageCount > 1 && (
                      <span className="uin-count" title={`${row.messageCount} messages`}>
                        {row.messageCount > 99 ? '99+' : row.messageCount}
                        <span className="sr-only"> messages</span>
                      </span>
                    )}
                  </span>
                  {/* Short enough to fit the column, with the whole date and
                      time in the little yellow box for anybody working out
                      exactly when. */}
                  <span title={formatFull(row.lastMessageAt, timezone)}>
                    {formatWhen(row.lastMessageAt, now, timezone)}
                  </span>
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

      {/* Not destructive - nothing is thrown away and it can be put back - so
          the keyboard starts on the yes, as it does everywhere else in here
          that a stray Return would do something harmless. */}
      <ConfirmDialog
        open={merging && !!mergePlan}
        title={mergePlan && mergePlan.losers.length > 1
          ? `Merge ${mergePlan.losers.length + 1} conversations into one?`
          : 'Merge these two conversations into one?'}
        body={mergePlan && (
          <>
            <p>
              Everything goes into <strong>{mergePlan.winner.subject?.trim() || 'the oldest of them'}</strong>,
              which is the one that started it. Nothing is thrown away, and you can
              put it back from the conversation itself afterwards.
            </p>
            {mergePlan.warning && <p><strong>{mergePlan.warning}</strong></p>}
          </>
        )}
        confirmLabel="Merge them"
        busy={busy}
        onCancel={() => setMerging(false)}
        onConfirm={() => { setMerging(false); void merge() }}
      />
    </>
  )
}
