'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { ThreadListRow } from '@/modules/unified-inbox/lib/db'
import { normaliseAddress } from '@/modules/unified-inbox/lib/addresses'
import {
  avatarHref,
  channelLabel,
  discussionFrom,
  discussionTo,
  formatFull,
  formatWhen,
  inboxHref,
  initialsFor,
  MAX_SHOWN,
  participantLabel,
  PER_PAGE,
} from '@/modules/unified-inbox/lib/list'
import { pickWinner, widenedAccessWarning } from '@/modules/unified-inbox/lib/thread-merge'
import {
  AlarmIcon, BinIcon, ChatIcon, ChevronDownIcon, FormIcon, InboundIcon, MailOpenIcon,
  MailSealedIcon, MergeIcon, NoteIcon, PaperclipIcon, PhoneIcon, ReplyIcon, RestoreIcon,
  SpamIcon, TickIcon,
} from './icons'
import { AdminTooltip } from '@/components/admin/Tooltip'
import { Avatar } from './Avatar'
import { ConfirmDialog } from './ConfirmDialog'
import { Dropdown } from './Dropdown'
import { useRegisterRows, useSelection, type PickedRow } from './Selection'
import { SnoozePanel } from './SnoozePanel'
import { useOfferUndo } from './UndoProvider'

// The list of conversations. Every state it can be in - filtered to nothing,
// searched for something that is not there, an inbox that has never collected
// anything - says which one it is, because "no conversations" in front of
// somebody who has just set the whole thing up is a bug report waiting to
// happen rather than an answer.
//
// A row lays itself out by how much room the list has been given rather than by
// how wide the window is (see the container query in inbox.css): across in one
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
  /** Whether this is the Bin folder. Read by the empty state, which has its own
   *  sentence to say, and by the bar - a Delete button over a list of things
   *  already deleted is an offer to do nothing, and a junk button there is an
   *  offer to move something between two folders it would stay hidden in
   *  either way. */
  bin: boolean
  /** Whose bin, when it is not the reader's own. Same job as `spamOwnerName`
   *  above and the same reason. */
  binOwnerName: string | null
  /** Whether this reader may open the settings the empty state would otherwise
   *  send them to. Being told where a button is on a screen you are not allowed
   *  to open is worse than not being told. */
  canManage: boolean
  /** Whether this reader may shut the site's front door. Marking a pile of
   *  conversations as junk is a thing anybody who can read them may do to their
   *  own screen; turning their senders away changes what everybody receives, so
   *  it takes the same grant as answering one - see the block dialog below and
   *  the single-conversation SpamButton, which draws the same line. */
  canBlock: boolean
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
  neverSynced, spam, spamOwnerName, bin, binOwnerName, canManage, canBlock, searching, now, timezone,
}: Props) {
  const router = useRouter()
  const offerUndo = useOfferUndo()
  // What is ticked lives above this component now, so that the buttons in the
  // header of the open conversation act on the same pile these ones do - see
  // Selection. The working out below is unchanged and stays here: this list is
  // the only thing that knows which rows are on the screen at the moment of a
  // press, and it knows it synchronously.
  const { selected, setSelected, clear: dropSelection } = useSelection()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [merging, setMerging] = useState(false)
  // Which conversation has been CLICKED but whose pane has not arrived yet, and
  // what the address said at the moment of the press. Both halves, because the
  // second is how this knows when it has stopped being true: once the address
  // no longer says what it said when the row was pressed, the server has
  // answered and the row's own guess can be dropped. Worked out in the render
  // rather than reset by an effect - an effect would redraw the list a second
  // time to say something the render already knew.
  const [opening, setOpening] = useState<{ id: string; from: string | null } | null>(null)
  const openingId = opening && opening.from === openThreadId ? opening.id : null
  // What the list should draw as the open one: the row that was pressed if one
  // was and the server has not answered yet, otherwise what the address says.
  const shownOpenId = openingId ?? openThreadId
  // Who the "block them as well?" question is about, and whether it is up at
  // all. Null when the question is not on the screen. An EMPTY LIST is a question
  // with nothing to block in it - a pile of internal discussions, senders
  // already turned away, or a reader who may not shut the front door - which is
  // still a question worth asking, because it is the only way back from a press
  // nobody meant. So "is it open" and "is there anybody to block" are two
  // different readings of this and cannot share one empty array.
  const [blocking, setBlocking] = useState<string[] | null>(null)
  /** The same thing with the null folded away, for the dialog to read. Whether
   *  this is empty is what decides which of the two questions is on the screen -
   *  the one with a front door in it, or the plain "are you sure". */
  const askedAbout = blocking ?? []
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

  // The same rows, in the shape the pick keeps them in, handed up so that a
  // button pressed in the open conversation can put the whole pile back the way
  // it stood. Only the list knows this; the pane beside it never sees a row.
  const shape = useMemo<PickedRow[]>(() => rows.map((row) => ({
    id: row.id,
    status: row.status,
    snoozeUntil: row.snoozeUntil ? row.snoozeUntil.toISOString() : null,
    unread: row.unread,
  })), [rows])
  useRegisterRows(shape)

  const onScreen = useMemo(() => new Set(rows.map((r) => r.id)), [rows])
  const picked = useMemo(() => selected.filter((id) => onScreen.has(id)), [selected, onScreen])
  const pickedSet = useMemo(() => new Set(picked), [picked])
  const pickedRows = useMemo(() => rows.filter((row) => pickedSet.has(row.id)), [rows, pickedSet])

  /** Which of the bar's buttons are worth offering.
   *
   *  A button that would change nothing is worse than no button: somebody picks
   *  six conversations they have all read, presses Mark as read because it is
   *  sitting there, and six requests go out to write down what was already
   *  written down. Worse, the bar reads as though there were something left to
   *  do - so the one press that WOULD do something is harder to find among four
   *  that would not.
   *
   *  So each one appears only where at least one picked conversation is not
   *  already in the state it would put them in. "At least one" rather than "all"
   *  on purpose: five read and one unread is exactly when Mark as read is the
   *  button somebody wants, and hiding it until every last one is unread would
   *  be a stricter rule that helps nobody.
   *
   *  The bar can never empty itself. Read and unread are opposites, so one of
   *  those two is always offered whatever is picked. */
  const offer = useMemo(() => ({
    done: pickedRows.some((row) => row.status !== 'done'),
    read: pickedRows.some((row) => row.unread),
    unread: pickedRows.some((row) => !row.unread),
    open: pickedRows.some((row) => row.status !== 'open'),
  }), [pickedRows])

  /** Everybody the picked conversations could be blocked on, once they are in
   *  the bin - distinct, normalised, and only where there is a front door to
   *  shut in the first place.
   *
   *  Discussions are left out: both ends of one are colleagues, and the address
   *  on it is somebody who works here. So is anything without an `@`, which is
   *  every caller and every text message - the junk still moves, and only the
   *  question afterwards is missing, exactly as it is on a single conversation.
   *
   *  Whether any of them is blocked ALREADY is deliberately not asked. The list
   *  of blocked senders is settings-grade reading (it names colleagues, and its
   *  route takes `manage`), and handing a copy to everybody who can open a list
   *  to save one line of a dialog is not a trade worth making. Blocking is
   *  written with ON CONFLICT DO NOTHING, so anybody already turned away simply
   *  stays that way, and the dialog says so. */
  const blockable = useMemo(() => {
    const found = new Set<string>()
    for (const row of pickedRows) {
      if (row.startedByUserId) continue
      const address = normaliseAddress(row.participantAddress ?? '')
      if (address.includes('@')) found.add(address)
    }
    return [...found]
  }, [pickedRows])

  const clearPicked = useCallback(() => {
    anchorRef.current = null
    dropSelection()
  }, [dropSelection])

  /** Whether the conversation open beside the list is one of the picked ones.
   *  Asked before a run rather than after it: the bar empties itself on the way
   *  out, and by then nothing is picked. */
  const openIsPicked = useCallback(
    () => !!openThreadId && picked.includes(openThreadId),
    [openThreadId, picked],
  )

  /** Back to the list with nothing open on it. */
  const closePane = useCallback(
    () => router.push(inboxHref(base, params, { id: null })),
    [base, params, router],
  )

  /** One row on or off, and the point any later run is measured from.
   *
   *  The first row picked while a conversation is open beside the list picks
   *  that conversation too. A mail program counts the message in the reading
   *  pane as part of the selection, this list already measures a shift-run from
   *  it, and it is drawn on the same tint a picked row wears - so somebody
   *  reading one conversation and ctrl-clicking a second to merge the two has
   *  every reason to believe they have picked two. They had picked one, and the
   *  Merge button, which wants two, never appeared. */
  const toggle = useCallback((id: string, index: number) => {
    anchorRef.current = index
    setSelected((current) => {
      if (current.includes(id)) return current.filter((x) => x !== id)
      // Off what is on the screen, not off the whole list: a tick left behind on
      // a page nobody is looking at is not a selection this row is joining.
      const nothingPicked = !current.some((x) => onScreen.has(x))
      const alsoOpen = nothingPicked && openThreadId && openThreadId !== id && onScreen.has(openThreadId)
      return alsoOpen ? [...current, openThreadId, id] : [...current, id]
    })
  }, [onScreen, openThreadId, setSelected])

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
  }, [rows, openThreadId, setSelected])

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
    // And say so on the row IMMEDIATELY.
    //
    // Which conversation is open lives in the address, so the highlight moving
    // used to wait on the server drawing the whole hub again - and in the
    // meantime a click on a conversation looked, to the person who made it,
    // exactly like a click that had missed. They clicked again. The row knows
    // perfectly well that it was the one pressed, so it says so at once and the
    // server confirms it a moment later, by which time the highlight is already
    // where the confirmation would have put it.
    setOpening({ id, from: openThreadId })
  }, [extendTo, openThreadId, setSelected, toggle])

  const onRowKeyDown = useCallback((e: React.KeyboardEvent, id: string, index: number) => {
    // Space on a link does nothing at all by default, so it is free to mean
    // "pick this one" - the keyboard's way in, now the tick box has gone.
    if (e.key !== ' ') return
    e.preventDefault()
    if (e.shiftKey) extendTo(index)
    else toggle(id, index)
  }, [extendTo, toggle])

  /** One request per conversation rather than a bulk endpoint: the routes
   *  already exist, already check who may touch which inbox, and six of them in
   *  parallel is not the thing that will slow this screen down. Settled rather
   *  than raced, so one refusal does not hide five successes.
   *
   *  Answers whether ANY of them went through, which the junk button needs: a
   *  question about blocking senders, put after a move that was refused
   *  outright, is a question about nothing.
   *
   *  `refresh` is there for the one caller that asks a question afterwards.
   *  Redrawing the page pulls this whole panel through a fresh server render,
   *  and a dialog put up in the same breath goes with it - it flashes on and is
   *  gone before anybody can read it, then turns up again on the next render as
   *  a dialog about something that happened a folder ago. So the junk button
   *  holds the redraw until the question has been answered, exactly as the
   *  single-conversation SpamButton holds its own leaving. */
  const runOnPicked = useCallback(async (
    send: (id: string) => Promise<Response>,
    { refresh = true, closes = false }: { refresh?: boolean; closes?: boolean } = {},
  ): Promise<boolean> => {
    if (picked.length === 0) return false
    const count = picked.length
    // Whether the conversation open beside the list is one of the ones about to
    // change. Asked BEFORE the run, because the answer decides where the reader
    // ends up and `picked` is emptied on the way out.
    const openWasPicked = closes && refresh && !!openThreadId && picked.includes(openThreadId)
    setBusy(true)
    setError('')
    try {
      const results = await Promise.allSettled(picked.map((id) =>
        send(id).then((r) => { if (!r.ok) throw new Error('refused') })
      ))
      const failed = results.filter((r) => r.status === 'rejected').length
      if (failed > 0) {
        setError(failed === count
          ? 'None of those could be changed.'
          : `${failed} of ${count} could not be changed. The rest were.`)
      }
      clearPicked()
      // A pile that has just been filed, put to sleep or binned has left the
      // list, and the conversation open beside it may have been in the pile - in
      // which case the pane is showing something the list no longer holds. It
      // goes back to "Nothing open", exactly as it does when the same thing is
      // done to that one conversation from its own header.
      if (openWasPicked) closePane()
      else if (refresh) router.refresh()
      return failed < count
    } finally {
      setBusy(false)
    }
  }, [closePane, picked, openThreadId, router, clearPicked])

  /** Where the picked conversations stand RIGHT NOW, as the changes that would
   *  put each of them back there.
   *
   *  Worked out at the moment of the press rather than when Undo is taken: by
   *  then the list has been redrawn and the rows are in their new state, so
   *  asking then would offer to put six conversations back to done when done is
   *  what the press had just made them. One change per conversation rather than
   *  one for the pile, because a pile picked off an All list is rarely all in
   *  the same state - and a snooze needs the date it was due back or the API
   *  refuses it. */
  const whereTheyStood = useCallback(() => pickedRows.map((row) => ({
    id: row.id,
    to: row.status === 'snoozed' && row.snoozeUntil
      ? { status: 'snoozed', snoozeUntil: row.snoozeUntil.toISOString() }
      : { status: row.status === 'done' ? 'done' : 'open' },
  })), [pickedRows])

  /** Put them all back, from a bar that has emptied itself and a list that has
   *  been redrawn since. Bare requests, and settled rather than raced: one
   *  conversation that will not go back is no reason to abandon the other five.
   *  The redraw afterwards belongs to the provider - see UndoProvider. */
  const putBack = useCallback((back: Array<{ id: string; to: Record<string, unknown> }>) => async () => {
    await Promise.allSettled(back.map(({ id, to }) => fetch(`/api/m/unified-inbox/threads/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(to),
    })))
  }, [])

  /** The same thing for the bin, which is a different door: junk is one
   *  person's opinion and is written through its own route rather than through
   *  the conversation's status. */
  const takeOutOfSpam = useCallback((ids: string[]) => async () => {
    await Promise.allSettled(ids.map((id) => fetch(`/api/m/unified-inbox/threads/${id}/spam`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spam: false }),
    })))
  }, [])

  /** And the same again for the bin, which is a third door: deleting something
   *  is neither a status nor an opinion about junk, and it has its own route. */
  const takeOutOfBin = useCallback((ids: string[]) => async () => {
    await Promise.allSettled(ids.map((id) => fetch(`/api/m/unified-inbox/threads/${id}/bin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bin: false }),
    })))
  }, [])

  /** "1 conversation", "6 conversations", for the sentence on the toast. */
  const them = useCallback((n: number) => (n === 1 ? 'conversation' : 'conversations'), [])

  const applyToPicked = useCallback((body: Record<string, unknown>) => runOnPicked((id) =>
    fetch(`/api/m/unified-inbox/threads/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  ), [runOnPicked])

  /** The three presses that take the pile OFF the list somebody is looking at:
   *  filing it, waking it, putting it to sleep. All three shut the pane if what
   *  was open was in the pile, and all three offer the five seconds in which
   *  the press was still a mistake.
   *
   *  Marking read and unread are not among them on purpose. Neither one moves a
   *  conversation anywhere, both undo themselves with the button sitting next to
   *  them, and a toast after every press on a bar is a toast people learn to
   *  ignore before they need one. */
  const closePicked = useCallback(async (body: Record<string, unknown>, said: string) => {
    const back = whereTheyStood()
    if (!(await runOnPicked((id) => fetch(`/api/m/unified-inbox/threads/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }), { closes: true }))) return
    offerUndo({ message: said, undo: putBack(back) })
  }, [offerUndo, putBack, runOnPicked, whereTheyStood])

  /** The whole picked pile into the bin. Sent by three different presses now -
   *  the button itself where there is nothing to ask, and both of the answers
   *  that are not Cancel - so it lives here rather than three times over. */
  const spamPicked = useCallback((opts?: { refresh?: boolean }) => runOnPicked((id) =>
    fetch(`/api/m/unified-inbox/threads/${id}/spam`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spam: true }),
    }), { ...opts, closes: true }), [runOnPicked])

  /** The picked pile into the bin, and the five seconds in which that was still
   *  a mistake.
   *
   *  No question first, unlike the junk button beside it, and the difference is
   *  what the press costs. Junking a pile also offers to shut the site's front
   *  door on the senders, which is a decision worth stopping to make; deleting
   *  moves conversations into a folder they can be lifted straight back out of,
   *  destroys nothing, and undoes itself from the toast. A dialog in front of
   *  every one of those is a dialog people learn to dismiss without reading,
   *  which is how the one that matters gets dismissed too. The press that
   *  genuinely throws things away is "Empty bin", in the folder, and it asks. */
  const deletePicked = useCallback(async () => {
    const ids = [...picked]
    if (!(await runOnPicked((id) => fetch(`/api/m/unified-inbox/threads/${id}/bin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bin: true }),
    }), { closes: true }))) return
    offerUndo({
      message: `${ids.length} ${them(ids.length)} moved to the bin.`,
      undo: takeOutOfBin(ids),
    })
  }, [offerUndo, picked, runOnPicked, takeOutOfBin, them])

  /** And back out again, which is the only bulk press the Bin folder offers.
   *  A bin somebody can fill fifty at a time and empty one at a time is a bin
   *  people stop putting things in. */
  const restorePicked = useCallback(async () => {
    const ids = [...picked]
    if (!(await runOnPicked((id) => fetch(`/api/m/unified-inbox/threads/${id}/bin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bin: false }),
    }), { closes: true }))) return
    offerUndo({
      message: `${ids.length} ${them(ids.length)} put back.`,
      undo: async () => {
        await Promise.allSettled(ids.map((id) => fetch(`/api/m/unified-inbox/threads/${id}/bin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bin: true }),
        })))
      },
    })
  }, [offerUndo, picked, runOnPicked, them])

  /** Two decisions, kept apart exactly as they are on a single conversation (see
   *  SpamButton, which explains why at length). Moving the pile is one person's
   *  opinion about their own screen; blocking the senders is a fact about the
   *  site, covers every address it has, and is asked rather than assumed.
   *
   *  NOTHING IS SENT ON THE PRESS. Six conversations into somebody's spam
   *  folder because a finger landed on the wrong button in a toolbar is six
   *  things to go and find again, so the press opens the question and every
   *  answer is still available - including "I did not mean that", which is the
   *  cross in the corner and leaves the pile exactly where it is. The question
   *  is asked even when there is nobody in the pile to block: that case has no
   *  door to offer, but it wants the way out just as much. */
  const markPickedSpam = useCallback(() => {
    setBlocking(canBlock ? blockable : [])
  }, [blockable, canBlock])

  /** The middle answer: junk the pile and leave the front door alone. Also the
   *  only answer on a question with nobody to block in it. */
  const movePickedOnly = useCallback(async () => {
    const ids = [...picked]
    setBlocking(null)
    if (!(await spamPicked())) return
    offerUndo({
      message: `${ids.length} ${them(ids.length)} moved to spam.`,
      undo: takeOutOfSpam(ids),
    })
  }, [offerUndo, picked, spamPicked, takeOutOfSpam, them])

  /** The yes: move them, then shut the door on all of them. One request per
   *  address rather than a list, for the same reason as the move, and settled
   *  for the same reason again - the error names how many of them did not take,
   *  and the ones that did are still blocked. */
  const moveAndBlockAll = useCallback(async () => {
    const addresses = blocking ?? []
    if (addresses.length === 0) return
    const ids = [...picked]
    // Where the reader ends up, decided before the run empties the bar.
    const wasOpen = openIsPicked()
    // No redraw while the dialog is still up: it pulls this whole panel through
    // a fresh server render and takes the dialog with it (see runOnPicked).
    // Which is also why the pane is not shut here - the navigation would do the
    // same thing to the dialog. It happens at the end, with the redraw.
    const moved = await spamPicked({ refresh: false })
    // Nothing moved, so there is nothing to shut a door behind. The run has
    // already said so on the screen.
    if (!moved) { setBlocking(null); router.refresh(); return }
    setBusy(true)
    // Whether the door actually shut, so the toast says the true sentence.
    let blocked = false
    try {
      const results = await Promise.allSettled(addresses.map((address) =>
        fetch('/api/m/unified-inbox/blocked-senders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address, blocked: true }),
        }).then((r) => { if (!r.ok) throw new Error('refused') })
      ))
      const failed = results.filter((r) => r.status === 'rejected').length
      if (failed > 0) {
        const message = failed === addresses.length
          ? 'Nobody was blocked. The junk was still moved.'
          : `${failed} of ${addresses.length} could not be blocked. The rest were.`
        // Added to whatever the move had to say rather than replacing it: one
        // press can now go wrong in two different places, and the half that
        // worked is worth knowing about either way.
        setError((previous) => [previous, message].filter(Boolean).join(' '))
      }
      blocked = failed < addresses.length
    } finally {
      setBusy(false)
      setBlocking(null)
      // The five seconds, and then the redraw the move itself was not allowed
      // to do - now that the dialog either would have swept away is going.
      //
      // Undo brings the conversations back out of the bin and stops there. The
      // senders stay turned away, and the toast says so: this list is
      // deliberately never told which of them were blocked ALREADY (see
      // `blockable`), so an undo that reopened every door would quietly let
      // people back in who were turned away weeks ago. Letting somebody back in
      // is done where blocking is done - the Spam folder, and the inbox
      // settings.
      offerUndo({
        message: blocked
          ? `${ids.length} ${them(ids.length)} moved to spam. The senders stay blocked.`
          : `${ids.length} ${them(ids.length)} moved to spam.`,
        undo: takeOutOfSpam(ids),
      })
      if (wasOpen) closePane()
      else router.refresh()
    }
  }, [blocking, closePane, offerUndo, openIsPicked, picked, router, spamPicked, takeOutOfSpam, them])

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
  }, [mergePlan, router, setSelected])

  if (rows.length === 0) {
    return (
      <div className="uin-empty">
        {bin ? (
          <>
            {/* First, ahead of everything else, for the reason the Spam folder
                gives below: an empty bin is the good outcome, and "nothing has
                been collected yet" over the top of one would send somebody off
                to check a mail account over nothing. */}
            <strong>Nothing in here</strong>
            {binOwnerName ? (
              <>
                Conversations deleted out of {binOwnerName}&rsquo;s post land here rather than in
                your own bin, because it is their post. Nothing is destroyed until somebody
                empties the bin, so anything that ends up in here by mistake can be put straight
                back.
              </>
            ) : (
              <>
                Conversations you delete land in this folder, and only you can see them - deleting
                something changes nothing for your colleagues. Nothing is destroyed until you
                empty the bin, and nothing in your mail account is ever touched.
              </>
            )}
          </>
        ) : spam ? (
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
          {/* Nearly all of this bar is drawings now. It used to be eight
              buttons with whole instructions written on them - "Mark as read",
              "Mark as unread", "Mark as spam" - which at eleven characters a
              word wrapped onto three lines inside a list column and pushed the
              rows down the screen every time anybody picked one. The same eight
              acts are the same eight icons the conversation beside the list
              already uses for them, so there is one drawing per act on the
              whole screen rather than a picture in one place and a sentence in
              the other. Each one carries the admin's own tooltip and a line for
              a screen reader - see BinButton, which draws its bin exactly this
              way and for exactly these reasons.

              The two that are still words are the two that say where a
              conversation STANDS rather than what is about to happen to it.
              "Done" and "Reopen" have no drawing anybody would recognise
              without being taught it, and a tick in a bar that also holds a bin
              and a no-entry sign reads as "confirm" rather than as "filed".

              Each of them only where it would actually do something - see
              `offer` above for why a button that changes nothing is worse than
              no button at all. */}
          {offer.done && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                    onClick={() => void closePicked(
                      { status: 'done' },
                      `${picked.length} ${them(picked.length)} marked as done.`,
                    )}>
              Done
            </button>
          )}
          {offer.open && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                    onClick={() => void closePicked(
                      { status: 'open' },
                      `${picked.length} ${them(picked.length)} opened again.`,
                    )}>
              Reopen
            </button>
          )}
          {offer.read && (
            <AdminTooltip body="Mark as read">
              <button type="button" className="uin-icon-btn uin-icon-btn-framed" disabled={busy}
                      onClick={() => void applyToPicked({ unread: false })}>
                {MailOpenIcon}
                <span className="sr-only">Mark the {picked.length} picked {them(picked.length)} as read</span>
              </button>
            </AdminTooltip>
          )}
          {offer.unread && (
            <AdminTooltip body="Mark as unread">
              <button type="button" className="uin-icon-btn uin-icon-btn-framed" disabled={busy}
                      onClick={() => void applyToPicked({ unread: true })}>
                {MailSealedIcon}
                <span className="sr-only">Mark the {picked.length} picked {them(picked.length)} as unread</span>
              </button>
            </AdminTooltip>
          )}
          {/* The one button in this bar that asks a question rather than doing a
              thing, so it is a menu rather than a press: "when" has no sensible
              default and a bar button that put six conversations to sleep until
              some hour nobody chose would be worse than no button.

              The same panel the clock on a single conversation opens, which is
              deliberate - one vocabulary for one idea, and the times underneath
              each answer are the SITE's, worked out once when the menu opens.
              The same clock face too, now that this bar is drawings: a control
              that opens the identical menu ought to look identical.

              Offered whatever is picked, including a pile that is already
              asleep: unlike Mark as read, choosing a new time for something that
              already has one is a real change rather than writing down what was
              already written. Bringing them back is not in here - "Reopen"
              beside it already does that for the whole pile. */}
          <AdminTooltip body="Snooze - set when these come back">
            <Dropdown
              className="uin-icon-btn uin-icon-btn-framed"
              label={AlarmIcon}
              ariaLabel="Set when these come back"
              align="start"
              width={280}
              disabled={busy}
              panelClassName="uin-menu-snooze"
            >
              <SnoozePanel
                timezone={timezone}
                busy={busy}
                title={picked.length === 1 ? 'Snooze this one' : `Snooze these ${picked.length}`}
                onSnooze={(until) => void closePicked(
                  { status: 'snoozed', snoozeUntil: until.toISOString() },
                  `${picked.length} ${them(picked.length)} snoozed.`,
                )}
              />
            </Dropdown>
          </AdminTooltip>
          {/* Not in the Spam folder, where everything on the screen is already
              marked and the button would be an offer to do it again - and not
              in the Bin, where marking something as junk would move it between
              two folders it stays hidden in either way. */}
          {!spam && !bin && (
            <AdminTooltip body="Junk - moves them to the spam folder">
              <button type="button" className="uin-icon-btn uin-icon-btn-framed" disabled={busy}
                      onClick={markPickedSpam}>
                {SpamIcon}
                <span className="sr-only">Move the {picked.length} picked {them(picked.length)} to the spam folder</span>
              </button>
            </AdminTooltip>
          )}
          {/* The bin, offered everywhere except the Bin folder itself - where
              the same button turns round and puts the pile back, because a bin
              you can fill fifty at a time and empty one at a time is a bin
              people stop using. Neither press destroys anything: that is the
              "Empty bin" button in the head of the folder, and it asks. */}
          {bin ? (
            <AdminTooltip body="Put them back">
              <button type="button" className="uin-icon-btn uin-icon-btn-framed" disabled={busy}
                      onClick={() => void restorePicked()}>
                {RestoreIcon}
                <span className="sr-only">Take the {picked.length} picked {them(picked.length)} out of the bin</span>
              </button>
            </AdminTooltip>
          ) : (
            <AdminTooltip body="Delete - moves them to the bin">
              <button type="button" className="uin-icon-btn uin-icon-btn-framed" disabled={busy}
                      onClick={() => void deletePicked()}>
                {BinIcon}
                <span className="sr-only">
                  Move the {picked.length} picked {them(picked.length)} to the bin. Nothing is
                  destroyed until the bin is emptied.
                </span>
              </button>
            </AdminTooltip>
          )}
          {/* Two or more, because merging one conversation into itself is not a
              thing - and only for whoever set the addresses up, since a merge
              across two of them changes who can read what. */}
          {canManage && picked.length > 1 && (
            <AdminTooltip body="Merge them into one conversation">
              <button type="button" className="uin-icon-btn uin-icon-btn-framed" disabled={busy}
                      onClick={() => setMerging(true)}>
                {MergeIcon}
                <span className="sr-only">Fold the {picked.length} picked conversations into one</span>
              </button>
            </AdminTooltip>
          )}
          {/* Still a word, and pushed to the far end of the bar. It is the one
              control here that acts on the PICK rather than on the post, and a
              ninth drawing in the row would be a ninth thing to work out before
              pressing anything. */}
          <button type="button" className="uin-chip uin-bulk-clear" disabled={busy} onClick={clearPicked}>
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
          const open = row.id === shownOpenId
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
                data-opening={openingId === row.id ? 'true' : undefined}
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

      {/* The foot of a list that grows rather than turning pages. Pressing this
          fetches the same list one helping longer, so the rows already read
          stay where they were and anything picked among them stays picked - a
          page turn threw both away halfway through choosing, which is what put
          people back to doing it one at a time.

          The conversation open beside the list is carried through as well.
          Turning a page closed it, because the row it belonged to was about to
          leave the screen; nothing leaves the screen now.

          Nothing at all where everything is already showing, and a sentence
          rather than a button at the ceiling - see MAX_SHOWN. A list that long
          is a list to search rather than to scroll. */}
      {rows.length < total && (
        <div className="uin-pager">
          <span>Showing {rows.length} of {total}</span>
          {rows.length < MAX_SHOWN ? (
            /* scroll={false} because the point of this button is that nothing
               moves: the router's own "go to the top on navigation" would send
               a reader who has just asked for more back to the first row, which
               is the page turn this replaced wearing a different hat. */
            <Link className="btn btn-secondary btn-sm" scroll={false}
                  href={inboxHref(base, params, { page: String(page + 1) })}>
              Show {Math.min(PER_PAGE, total - rows.length)} more
            </Link>
          ) : (
            <span>Search, or narrow it down above, to reach the rest.</span>
          )}
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

      {/* Both decisions, put together, before either of them has happened. The
          middle answer is the ordinary one - junk them and leave the front door
          where it was - and Cancel means the press was a mistake. */}
      <ConfirmDialog
        open={blocking !== null}
        title={askedAbout.length > 0
          ? (askedAbout.length > 1 ? `Block all ${askedAbout.length} of them as well?` : 'Block them as well?')
          : (picked.length > 1 ? `Move ${picked.length} conversations to spam?` : 'Move it to the spam folder?')}
        body={<>
          {/* Whose bin each one lands in is worked out per conversation on the
              server, and a pile picked off one list can span several addresses -
              so this says which rule is applied rather than naming a folder it
              cannot know. "Moved to your spam" would be a plain untruth over a
              colleague's own post. */}
          <p>
            {picked.length > 1 ? 'They will go' : 'It will go'} into a spam folder: your own, or
            the colleague&rsquo;s where the address is theirs rather than the team&rsquo;s.
            Nothing is deleted, and nobody else&rsquo;s view of
            {picked.length > 1 ? ' them changes.' : ' it changes.'}
          </p>
          {askedAbout.length > 0 ? (
            <p>
              Would you also like to turn {askedAbout.length > 1 ? 'these senders' : <strong>{askedAbout[0]}</strong>} away
              in future? Nothing further from them would reach an inbox on this site - shared or
              personal. It would be dropped straight in here instead, marked as dealt with and left
              unread, so you can still see what they sent. Nothing already here would be touched,
              anybody already turned away simply stays that way, and you can let them back in from
              the Spam folder or from the inbox settings.
            </p>
          ) : (
            /* Nobody in this pile to turn away: internal discussions, senders
               already blocked, or a reader who may not shut the front door. The
               question is still worth putting - it is the way back. */
            <p>Open the Spam folder and press the same button to bring anything straight back.</p>
          )}
          {askedAbout.length > 1 && (
            <ul>
              {askedAbout.map((address) => <li key={address}><strong>{address}</strong></li>)}
            </ul>
          )}
        </>}
        confirmLabel={askedAbout.length > 0
          ? (askedAbout.length > 1 ? 'Block them all' : 'Block them')
          : (picked.length > 1 ? 'Move them' : 'Move it')}
        other={askedAbout.length > 0
          ? { label: 'No, just move them', onClick: movePickedOnly }
          : undefined}
        cancelLabel="Cancel"
        // Only where the yes shuts the front door. A move undoes itself with the
        // same button, so the keyboard may start on it.
        destructive={askedAbout.length > 0}
        busy={busy}
        // Nothing has been sent yet, so this really does undo the press.
        onCancel={() => { if (!busy) setBlocking(null) }}
        onConfirm={() => void (askedAbout.length > 0 ? moveAndBlockAll() : movePickedOnly())}
      />
    </>
  )
}
