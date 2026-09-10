'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { LinkBusy } from './NavProgress'
import { useRouter } from 'next/navigation'
import { avatarHref, inboxHref, initialsFor, moveInOrder, sortByStoredOrder, splitInboxes } from '@/modules/unified-inbox/lib/list'
import {
  AlarmIcon, AssignedIcon, AtIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon, FileIcon, FolderIcon,
  InboxIcon, MegaphoneIcon, MenuIcon, PeopleIcon, SendIcon, SpamIcon,
} from './icons'
import { Avatar } from './Avatar'
import { CheckNowButton, type CheckNowNotice } from './CheckNowButton'
import { NewMailNotifier } from './NewMailNotifier'
import { InboxSearch } from './InboxSearch'
import { ComposeMenu, type ComposeMenuEntry } from './ComposeMenu'

// Everywhere you can go, down the left.
//
// It was a strip of tabs across the top, which is where a browser puts three of
// something. There are a dozen here on a site with a handful of addresses, and
// a dozen tabs is a horizontal scrollbar with half of them behind it. A rail is
// what every mail program in the world uses for the same list, it reads down in
// one go, and it leaves the width of the screen to the thing somebody came here
// to read. Below 1200px there is not room for a column of it, and it becomes a
// bar along the top saying where you are, with the whole column folded behind
// it as a drawer - same markup, same order, no second component. It was a
// strip that scrolled sideways there, which on a phone was a dozen names with
// half of them off the edge and nothing to say so.
//
// FIVE GROUPS, and the split is the useful one rather than the tidy one.
// "Yours" is the handful of places one person opens all day - their own
// address, everything at once, what they have been tagged in, what they have
// half-written and what they have sent. Sent there is THEIRS: their own writing,
// wherever it went out from. What has been HANDED to them is not a place: it
// shows in their own address, beside the post that arrived there, because a
// second list somebody has to remember to check is a list that goes unchecked.
// "Shared inboxes" is the addresses the business owns, which is where a colour
// beside each name earns its keep: on a site with six of them the name is read
// second and the colour first. Each one opens out into its own Sent folder -
// everything that has left it, whoever wrote it, including the mail a module
// sent on its own - which is the question somebody asks of a shared address and
// cannot ask of their own folder. "Team inboxes" is colleagues' own post this
// person has been let in to - covering somebody's mail while they are away,
// working their diary - and each one opens out into that colleague's Drafts,
// Sent, Mentioned and bin. All four are THEIRS: covering somebody's post means
// knowing what they have half-answered as well as what they have answered, and
// not knowing is how the same customer gets written to twice. Then the channels
// another module owns, then the three screens that are not a list of post at
// all.
//
// The two groups that open out do it the same way, through Branch below: the
// coloured dot in front of the name IS the arrow, and it becomes one under the
// pointer.
//
// Two different things put an address under Yours and they are not the same
// fact. An INDIVIDUAL inbox this person OWNS is their own post. A SHARED inbox
// pinned as somebody's own is a preference - purchasing@ is still the team's,
// it is simply the one they open on - and it is the one exception to the rail
// being the same for everybody. All stays right under both rather than going
// away, because somebody who works purchasing@ still wants to see the lot
// without hunting.
//
// An individual inbox somebody ELSE owns is neither. It goes under Team
// inboxes, named for the colleague rather than for the address, because "Sam"
// is how anybody covering Sam's post thinks of it and "sam@" is not.
//
// Unread counts ride beside the names, because "is there anything new in
// accounts@" is the question this rail is answering.
//
// Fetching new mail sits in a box stuck to the foot of it, under a rule: "has
// anything come in" is asked of the whole screen rather than of one address,
// and it is a thing to do rather than a place to go. Beside it is when the post
// last arrived, because that is the question somebody is really asking when
// they reach for the button.
//
// Every group can be dragged into the order somebody wants it in, and each of
// them keeps to itself: a list is put in an order against the other things in
// the same list, and a channel landing among the addresses would be nonsense.
//
// Yours is the odd one out, and the difference is whose order it is. The shared
// addresses, the colleagues' inboxes and the channels are the SITE's - one
// arrangement everybody opens - so rearranging them takes the permission that
// looks after the place. Yours is one person's own working day, seen by nobody
// else, so it is saved against the person and needs no permission at all.
//
// Dropping saves straight away and the rail moves first: the gesture is over in
// half a second and a list that snaps back while a request finishes reads as a
// bug. A refused save puts the order back and says so.
//
// Nothing announces the drag while the pointer is merely passing over a row.
// The rail is a list of places to go and it wears the cursor of one; a row that
// turns into a grab handle under every hover tells somebody reading their post
// about a job done once a year, every single time they look down the list.

export type TabInbox = {
  id: string
  name: string
  address: string
  /** Whose post it is. Decides which of the three groups it sits in - and, with
   *  it, which list it is dragged about within. */
  kind: 'individual' | 'shared'
  /** Which colleague's, on an individual one. Null on a shared address, and
   *  null on an individual one whose owner's account has gone - which is why
   *  the group below falls back to the address's own name rather than assuming
   *  there is a person to name. */
  ownerUserId: string | null
  ownerName: string | null
  /** How many conversations here are still OPEN - not what has arrived unread.
   *  It is the same number the list behind it shows, because clicking an
   *  address lands on the Open tab: a badge that emptied itself the moment
   *  somebody glanced at the list was a badge that said nothing about the work
   *  left. See openCounts in lib/db.ts. */
  count: number
}
export type TabChannel = { key: string; label: string; count: number }

type Props = {
  base: string
  params: Record<string, string>
  inboxes: TabInbox[]
  channels: TabChannel[]
  /** Every open conversation this person can see, for the All entry. */
  allCount: number
  /** Which entry is on: an inbox id, `m:<module>`, 'none', 'drafts', 'scheduled', 'sent',
   *  'contacts', 'campaigns', 'mentions', one of `sent:<inbox id>` /
   *  `drafts:<inbox id>` / `mentions:<inbox id>` for a folder under a
   *  colleague's name, or null for All. */
  current: string | null
  /** Who is reading, for the picture and initials at the head of the rail, and
   *  for telling their own address apart from the ones merely pinned to it. */
  me: { id: string; name: string }
  /** Whether to ask for their own picture at all. Off unless the site has
   *  switched it on - see Settings, People. */
  showAvatars: boolean
  /** Things colleagues have tagged this person in and that they have not dealt
   *  with yet. Open only: something set aside until Thursday is not waiting, and
   *  a number that counts it makes the place look busier than it is. */
  askedCount: number
  /** The order this person keeps the top of the rail in, by entry key. Empty
   *  when they have never rearranged it, which leaves it as it comes. */
  railOrder: string[]
  /** How many people are in the address book, beside Contacts. */
  contactCount: number
  /** Whether this person may write campaigns. Its own grant: somebody who may
   *  rename a folder is not, by that fact, somebody who may email five thousand
   *  customers. */
  showCampaigns: boolean
  /** Whether conversations that landed in no inbox are this person's to see. */
  showUnrouted: boolean
  unroutedCount: number
  /** Whether Drafts is worth offering: nothing put down half-written, no
   *  folder. The panel keeps it while the reader is standing in it, so emptying
   *  the folder does not take the list they are on out of the rail. */
  showDrafts: boolean
  draftCount: number
  /** How much each colleague has left half-written on their OWN address, keyed
   *  by inbox id, for the Drafts folder under their name. Matched against the
   *  address's owner in the query behind it, so a number here is never this
   *  reader's own writing and never somebody else's address's. The folder is
   *  offered whether or not there is anything in it, the same as the three
   *  beside it: a folder that appears only once it has something in it is a
   *  folder people assume ate their message. */
  draftCounts: Record<string, number>
  /** Whether Scheduled is worth offering, on the same terms as Drafts above:
   *  only once there is something waiting in it, and kept while the reader is
   *  standing in it so sending the last one does not take the list out from
   *  under them. */
  showScheduled: boolean
  /** How many are waiting for a time to come round. */
  scheduledCount: number
  /** How much is in this person's own spam folder. Always offered, unlike
   *  Drafts: the folder is where junk goes the moment anybody presses the
   *  button, so it has to be somewhere they can already see - a folder that
   *  appears only once it has something in it is a folder people assume ate
   *  their message. */
  spamCount: number
  /** Where "Write a message" goes, or null when there is no address this person
   *  may send from - in which case the button is not there at all, rather than
   *  there and disappointing. */
  composeHref: string | null
  /** The other things the button beside it can start - a discussion, a call, a
   *  text - already narrowed to the ones this site can actually do. Empty means
   *  no arrow at all, and the button is exactly what it was before the menu
   *  existed. */
  composeEntries: ComposeMenuEntry[]
  /** The address this person calls their own, pinned to the front of the rail,
   *  or null when they have not been given one. Already known to be one they
   *  may read - the panel resolves it against the visible list. */
  defaultInboxId: string | null
  /** Whether this person may drag the addresses into a different order. The
   *  order is the site's rather than one person's, so it takes `manage`. */
  canReorder: boolean
  /** Whether to offer fetching new mail on the spot. Asked as its own question
   *  rather than read off canReorder: collecting mail takes `manage` AND a mail
   *  account to collect from, and a site whose only channels are a chat and an
   *  enquiry form has nothing for the button to do. */
  canCheckNow: boolean
  /** Seconds between checks that run on their own while this page is open and
   *  in front of somebody, or null when the site has not asked for that. Only
   *  meaningful alongside canCheckNow - the button owns the timer, and there is
   *  no timer without the button. */
  autoCheckSeconds: number | null
  /** When any mail account was last opened, in milliseconds, or null when none
   *  ever has been. Read at the foot of the rail as a clock time, and moved on
   *  by every check this page runs. */
  lastCheckedAt: number | null
  /** The site's own timezone, which is the clock that time is told on. */
  timezone: string
}

/**
 * Which of the five colours an address wears.
 *
 * Worked out from its id rather than chosen, so a site gets a rail of different
 * colours without anybody being asked to pick six of them, and the same address
 * is the same colour on every screen, for every colleague, for as long as it
 * exists. Five, because those five are semantic tokens that are already correct
 * in both light and dark mode - a wider palette would mean hex values in a
 * stylesheet, and a hex value is a colour that is wrong in one of the two
 * themes.
 */
export function toneFor(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return (hash % 5) + 1
}

/**
 * When the post last arrived, as somebody would say it.
 *
 * In the SITE's timezone rather than the browser's, which is what makes this
 * safe to render on the server and on the client and get the same string twice
 * - the alternative is a line that is one thing in the HTML and another after
 * hydration, which React reports as an error and readers see as a flicker. It
 * is also the more useful clock: a business's post arrives on the business's
 * time, whatever time zone somebody happens to be reading it in.
 */
function updatedLabel(at: number | null, timezone: string): string {
  if (at === null) return 'never'
  const clock = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: timezone,
  }).format(at)
  const day = (ms: number) => new Intl.DateTimeFormat('en-GB', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: timezone,
  }).format(ms)
  // The date only when it was not today. "Updated: 09:14" on a screen somebody
  // opened this morning is the whole answer; the same line three days later is
  // a lie by omission.
  if (day(at) === day(Date.now())) return clock
  return `${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: timezone }).format(at)}, ${clock}`
}

/** One entry's count. Two shapes: the loud one for conversations nobody has
 *  read, the quiet one for totals that are simply how many of a thing there
 *  are. Same ceiling on both - two thresholds on one visual chip is one too
 *  many. */
function Count({ value, word = 'open', quiet = false }: { value: number; word?: string; quiet?: boolean }) {
  if (!value) return null
  return (
    <span className={quiet ? 'uin-rail-count uin-rail-count-quiet' : 'uin-rail-count'}>
      {value > 999 ? '999+' : value}
      <span className="sr-only"> {word}</span>
    </span>
  )
}

/** One entry, as plain data. Nothing in here is a function: the drag lives on
 *  the list rather than on each of its rows (see below), so an entry is only
 *  ever a handful of strings and the address it points at. */
type RailItem = {
  key: string
  href: string
  active: boolean
  /** An icon, for the places that are not an address. */
  icon?: React.ReactNode
  /** Or one of the five colours, for the ones that are. */
  tone?: number
  name: string
  /** What the browser puts in the little yellow box. */
  title?: string
  count?: React.ReactNode
  /** The address this row stands for, when it is one that can be dragged. It is
   *  what the list's own drag handlers read back off the element under the
   *  pointer, and it is absent on everything that does not move. */
  dragId?: string
  /** Whether this one is in the air, or is the one it would land on. */
  dragging?: boolean
  over?: boolean
  /** Said inside the link rather than hung on it: a link takes its name from
   *  what is in it, so this reaches the keyboard everywhere. */
  hint?: string
}

function Entry({ item }: { item: RailItem }) {
  return (
    <li>
      <Link
        className="uin-rail-item"
        href={item.href}
        aria-current={item.active ? 'page' : undefined}
        title={item.title}
        draggable={item.dragId ? true : undefined}
        data-uin-drag={item.dragId ? '1' : undefined}
        data-uin-id={item.dragId}
        data-uin-dragging={item.dragging ? '1' : undefined}
        data-uin-over={item.over ? '1' : undefined}
      >
        {item.tone
          ? <span className="uin-rail-dot" data-tone={item.tone} aria-hidden="true" />
          : <span className="uin-rail-icon">{item.icon}</span>}
        <span className="uin-rail-name">{item.name}</span>
        {item.count}
        {item.hint && <span className="sr-only">. {item.hint}</span>}
        <LinkBusy />
      </Link>
    </li>
  )
}

/**
 * One address that opens out into folders of its own.
 *
 * The colour IS the control. It used to be a chevron sitting in front of the
 * row, which cost every one of those names an indent the other groups did not
 * have, for an arrow most people never press - so the dot that was inside the
 * link comes out of it and becomes the button, in exactly the place the dot
 * stood. It reads as a coloured dot until the pointer is on the row, and turns
 * into the arrow then.
 *
 * Outside the link rather than inside it, because a control inside a link is one
 * you cannot press without going where the link goes.
 *
 * The folders are hidden rather than unmounted, so the button always controls
 * something that exists.
 */
function Branch({ id, item, opens, folders, open, onToggle }: {
  /** The address, for the id the button points its aria-controls at. */
  id: string
  /** The row itself - where it goes, what it is called, whether it can be
   *  dragged. Its `tone` is the dot, which is why it is not drawn as an Entry. */
  item: RailItem
  /** What the button says it opens, said out of sight: "the folders under Sam",
   *  "the Sent folder under Sales". */
  opens: string
  folders: RailItem[]
  open: boolean
  onToggle: () => void
}) {
  return (
    <li>
      <div className="uin-rail-branch">
        <button
          type="button"
          className="uin-rail-twist"
          aria-expanded={open}
          aria-controls={`uin-rail-folders-${id}`}
          onClick={onToggle}
        >
          <span className="uin-rail-dot" data-tone={item.tone ?? toneFor(id)} aria-hidden="true" />
          <span className="uin-rail-twist-icon" aria-hidden="true">{ChevronRightIcon}</span>
          <span className="sr-only">{open ? `Hide ${opens}` : `Show ${opens}`}</span>
        </button>
        <Link
          className="uin-rail-item"
          href={item.href}
          aria-current={item.active ? 'page' : undefined}
          title={item.title}
          draggable={item.dragId ? true : undefined}
          data-uin-drag={item.dragId ? '1' : undefined}
          data-uin-id={item.dragId}
          data-uin-dragging={item.dragging ? '1' : undefined}
          data-uin-over={item.over ? '1' : undefined}
        >
          <span className="uin-rail-name">{item.name}</span>
          {item.count}
          {item.hint && <span className="sr-only">. {item.hint}</span>}
          <LinkBusy />
        </Link>
      </div>
      <ul
        id={`uin-rail-folders-${id}`}
        className="uin-rail-list uin-rail-sub"
        hidden={!open}
      >
        {folders.map((folder) => <Entry key={folder.key} item={folder} />)}
      </ul>
    </li>
  )
}

/** What is said, out of sight, on a row somebody can move. The gesture itself
 *  is a mouse gesture; this is the same job for anybody who is not holding
 *  one. */
const REORDER_HINT = 'Hold Alt and press the up or down arrow keys to move it along the rail.'

/** Which of the two rows in the air a list is currently showing. */
type RailDragState = { dragId: string | null; overId: string | null }

/** Everything a rearrangeable list hangs on its own <ul>. Optional to a one,
 *  because a list nobody may rearrange hangs none of them. */
type RailDragHandlers = {
  onDragStart?: React.DragEventHandler<HTMLUListElement>
  onDragOver?: React.DragEventHandler<HTMLUListElement>
  onDragLeave?: React.DragEventHandler<HTMLUListElement>
  onDrop?: React.DragEventHandler<HTMLUListElement>
  onDragEnd?: React.DragEventHandler<HTMLUListElement>
  onKeyDown?: React.KeyboardEventHandler<HTMLUListElement>
}

/** The movable row under the pointer, or under whatever has the keyboard. The
 *  drag is hung on the list rather than on each of its rows: fourteen addresses
 *  is fourteen sets of five handlers, all of them saying the same thing, and
 *  one set that asks the DOM what it landed on says it once. */
const rowUnder = (event: { target: EventTarget | null }): HTMLElement | null =>
  (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-uin-id]') ?? null

/**
 * One list that can be put in an order - the shared addresses, the colleagues'
 * inboxes, the channels - as the handlers to hang on it and the two rows that
 * are currently in the air.
 *
 * `move` is told which row was picked up and which one it was dropped on, in
 * whatever ids that list is keyed by, and the caller decides what those mean.
 */
function useRailDrag(enabled: boolean, move: (fromId: string, toId: string) => void): {
  state: RailDragState
  handlers: RailDragHandlers
} {
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const onDragStart = (event: React.DragEvent<HTMLUListElement>) => {
    const id = rowUnder(event)?.dataset.uinId
    if (!id) return
    setDragId(id)
    // Overwritten deliberately: a dragged link otherwise carries its own URL,
    // and dropping it on the address bar or another window would be a surprise
    // nobody asked for.
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', id)
  }
  const onDragOver = (event: React.DragEvent<HTMLUListElement>) => {
    if (!dragId) return
    const id = rowUnder(event)?.dataset.uinId
    if (!id) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setOverId(id)
  }
  const onDragLeave = (event: React.DragEvent<HTMLUListElement>) => {
    const id = rowUnder(event)?.dataset.uinId
    if (id) setOverId((c) => (c === id ? null : c))
  }
  const onDrop = (event: React.DragEvent<HTMLUListElement>) => {
    const id = rowUnder(event)?.dataset.uinId
    if (!dragId || !id) return
    event.preventDefault()
    const from = dragId
    setDragId(null)
    setOverId(null)
    move(from, id)
  }
  const onDragEnd = () => { setDragId(null); setOverId(null) }

  // Alt and an arrow key does what dragging does, because a rearrangement only
  // a mouse can perform is a rearrangement some people cannot perform at all.
  // Counted off the rows that actually move rather than off every link in the
  // list: a colleague's folders hang inside their row, and counting those would
  // make the second name in the group the fourth thing on the keyboard.
  const onKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    if (!event.altKey) return
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    const from = rowUnder(event)
    const fromId = from?.dataset.uinId
    if (!from || !fromId) return
    // Held in a local: React empties currentTarget the moment the handler
    // returns, and the focus below happens a frame later.
    const list = event.currentTarget
    const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-uin-id]'))
    const index = rows.indexOf(from)
    const to = event.key === 'ArrowUp' ? index - 1 : index + 1
    if (index < 0 || to < 0 || to >= rows.length) return
    const toId = rows[to]!.dataset.uinId
    if (!toId) return
    event.preventDefault()
    move(fromId, toId)
    // The keyboard follows the row it just moved, so a second press carries on
    // from where it is rather than from whatever landed under the cursor.
    requestAnimationFrame(() => {
      list.querySelectorAll<HTMLElement>('[data-uin-id]')[to]?.focus()
    })
  }

  return {
    state: { dragId, overId },
    handlers: enabled
      ? { onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd, onKeyDown }
      : {},
  }
}


export function NavRail({
  base, params, inboxes, channels, allCount, current, me, showAvatars, askedCount, railOrder,
  showUnrouted, unroutedCount, showDrafts, draftCount, draftCounts, showScheduled, scheduledCount,
  spamCount, contactCount, showCampaigns, composeHref,
  composeEntries,
  defaultInboxId, canReorder, canCheckNow, autoCheckSeconds, lastCheckedAt, timezone,
}: Props) {
  const router = useRouter()
  const [notice, setNotice] = useState<CheckNowNotice | null>(null)
  // Bumped on every answer, and used as the box's key. Two presses that come
  // back with the same words are otherwise the same element in the same place,
  // and an element React does not replace never restarts the fade - the second
  // answer would arrive already halfway out.
  const [noticeSeq, setNoticeSeq] = useState(0)
  const showNotice = useCallback((next: CheckNowNotice | null) => {
    setNotice(next)
    setNoticeSeq((seq) => seq + 1)
  }, [])
  const [order, setOrder] = useState(inboxes)
  // The top of the rail in this person's own order, held as keys. Optimistic
  // like the two site-wide orders below it and for the same reason: a list that
  // snaps back while a request finishes reads as a bug.
  const [mineOrder, setMineOrder] = useState(railOrder)
  // The channels in the order the site keeps them, beside the addresses and for
  // the same reason: a drag has to move on the screen before the save comes
  // back, or a list that snaps back mid-gesture reads as a bug.
  const [channelOrder, setChannelOrder] = useState(channels)
  // Which colleagues' folders are showing. Held here rather than in the address
  // because it is furniture rather than a place: opening Sam's folders is not
  // somewhere to send a colleague a link to, and putting it in the query string
  // would make every list below reload to draw three static rows.
  const [opened, setOpened] = useState<string[]>([])
  const [error, setError] = useState('')
  // Whether this browser can be nudged at all, which only the browser knows.
  // See the box at the foot of the rail: on a site with no mail account the
  // bell is the only thing in it, and an empty bordered box is worse than none.
  const [bellShown, setBellShown] = useState(false)

  // When a check this page ran actually opened the accounts, or null until one
  // has. Held beside what the server said rather than replacing it, and the
  // newer of the two is what gets read below: a refresh carrying an older
  // figure - one account checked while another was not - cannot then wind the
  // clock back.
  const [ownCheckedAt, setOwnCheckedAt] = useState<number | null>(null)
  const checkedAt = Math.max(lastCheckedAt ?? 0, ownCheckedAt ?? 0) || null

  // Whether the drawer is out, below 1200px. Above that the same box is a
  // column that is always showing and this is simply never read. Never open on
  // a first render, so the server and the browser agree about the markup.
  const [placesOpen, setPlacesOpen] = useState(false)
  const placesButton = useRef<HTMLButtonElement>(null)
  const drawerClose = useRef<HTMLButtonElement>(null)
  const openPlaces = useCallback(() => setPlacesOpen(true), [])
  const closePlaces = useCallback(() => {
    setPlacesOpen(false)
    // Back to the button that opened it, so the keyboard is not left standing
    // in a box that has just slid off the screen.
    placesButton.current?.focus()
  }, [])
  // The keyboard lands on the way out as the drawer opens, which is the first
  // thing in it. Escape shuts it from anywhere inside.
  useEffect(() => {
    if (placesOpen) drawerClose.current?.focus()
  }, [placesOpen])
  useEffect(() => {
    if (!placesOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePlaces()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [closePlaces, placesOpen])
  // Picking a place shuts the drawer. Read off the click rather than wired into
  // every Entry: a link is a link, and the drawer is the one that cares.
  const onDrawerClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement | null)?.closest('a')) setPlacesOpen(false)
  }, [])

  // The answer to a press, gone by itself three seconds later. Only the good
  // one: an error has to stay until the next press, because somebody has to be
  // able to read why nothing was collected, and a red box that disappears while
  // they are looking at the list is worse than no box at all.
  useEffect(() => {
    if (!notice || notice.tone !== 'ok') return
    // 3s of being read plus the fade the stylesheet then runs, so the box is
    // taken away at the end of the fade rather than part of the way through it.
    const clear = window.setTimeout(() => setNotice(null), 3450)
    return () => window.clearTimeout(clear)
  }, [notice, noticeSeq])

  // What the server last told us, so a refresh that genuinely changed the list
  // (an address added, one deleted, somebody else's rearrangement) replaces what
  // is on screen, while our own optimistic move does not get overwritten by the
  // refresh it triggered.
  const serverKey = inboxes.map((i) => `${i.id}:${i.count}`).join('|')
  const lastServerKey = useRef(serverKey)
  useEffect(() => {
    if (lastServerKey.current === serverKey) return
    lastServerKey.current = serverKey
    setOrder(inboxes)
  }, [serverKey, inboxes])

  // And for the personal order, which the server sends back on every draw.
  const mineKey = railOrder.join('|')
  const lastMineKey = useRef(mineKey)
  useEffect(() => {
    if (lastMineKey.current === mineKey) return
    lastMineKey.current = mineKey
    setMineOrder(railOrder)
  }, [mineKey, railOrder])

  // The same bargain for the channels. Their own key rather than a shared one:
  // an address arriving must not throw away a channel somebody is halfway
  // through moving, and the two lists are saved down two different routes.
  const channelKey = channels.map((c) => `${c.key}:${c.count}`).join('|')
  const lastChannelKey = useRef(channelKey)
  useEffect(() => {
    if (lastChannelKey.current === channelKey) return
    lastChannelKey.current = channelKey
    setChannelOrder(channels)
  }, [channelKey, channels])

  /** Send an order the site has just been shown, and put the list back where it
   *  was if the site will not have it. One function for both lists: they are
   *  two routes and two shapes of body, and everything either of them does
   *  about a refusal is the same sentence in the same box. */
  const saveOrder = useCallback(async (url: string, body: unknown, undo: () => void) => {
    setError('')
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        undo()
        setError((await response.json().catch(() => null))?.error ?? 'That order did not save.')
        return
      }
      router.refresh()
    } catch {
      undo()
      setError('The site could not be reached, so the order is as it was.')
    }
  }, [router])

  // This person's own addresses, out in front, and everything else in the order
  // the site keeps. Both halves are worked out from one list so the drag below
  // can talk in one and save in the other.
  const { yours, shared, team } = splitInboxes(order, defaultInboxId, me.id)

  // Said in addresses rather than in positions, because the rail as it is drawn
  // and the order the site keeps are two different lists the moment anything is
  // pinned. Resolving against the site's own order here is what keeps the
  // pinned address exactly where it was in it - pinning is one person's
  // preference and must not rearrange the rail for everybody else.
  //
  // One function for the shared addresses and for colleagues' inboxes, because
  // both groups are drawn out of the one order and a move within either of them
  // is the same edit to it.
  const move = useCallback((fromId: string, toId: string) => {
    const next = moveInOrder(
      order,
      order.findIndex((i) => i.id === fromId),
      order.findIndex((i) => i.id === toId),
    )
    if (next === order) return
    const previous = order
    setOrder(next)
    // Told ahead of the answer rather than after it: a good save asks for a
    // refresh, and a key still describing the old order would take the refresh
    // as somebody else's rearrangement and put the rail back.
    lastServerKey.current = next.map((i) => `${i.id}:${i.count}`).join('|')
    void saveOrder(
      '/api/m/unified-inbox/admin/inboxes/reorder',
      { ids: next.map((i) => i.id) },
      () => {
        lastServerKey.current = previous.map((i) => `${i.id}:${i.count}`).join('|')
        setOrder(previous)
      },
    )
  }, [order, saveOrder])

  /** The same move, for the channels another module owns. Said in keys because
   *  that is what a channel has instead of a row of its own. */
  const moveChannel = useCallback((fromKey: string, toKey: string) => {
    const next = moveInOrder(
      channelOrder,
      channelOrder.findIndex((c) => c.key === fromKey),
      channelOrder.findIndex((c) => c.key === toKey),
    )
    if (next === channelOrder) return
    const previous = channelOrder
    setChannelOrder(next)
    lastChannelKey.current = next.map((c) => `${c.key}:${c.count}`).join('|')
    void saveOrder(
      '/api/m/unified-inbox/admin/channels/reorder',
      { keys: next.map((c) => c.key) },
      () => {
        lastChannelKey.current = previous.map((c) => `${c.key}:${c.count}`).join('|')
        setChannelOrder(previous)
      },
    )
  }, [channelOrder, saveOrder])

  // Changing where you are always goes back to page one, drops whichever
  // conversation was open - it belongs to the list being left - and lets go of
  // whoever the last list was narrowed to, which is a cut made on one list
  // rather than a thing that follows somebody around the rail.
  const link = (inbox: string | null, changes: Record<string, string | null> = {}) =>
    inboxHref(base, params, {
      inbox, page: null, id: null, person: null, compose: null, draft: null, assignee: null,
      // The address book's own params go with the entry that owns them. Left on,
      // an organisation card stayed pinned open beside the morning's post.
      org: null, view: null, edit: null, import: null, cat: null,
      ...changes,
    })

  // What the address a nudge is about is called. Null when this person has not
  // been given one of their own, where the honest answer is "everything you can
  // read" and naming an address would be a plain untruth.
  const ownInboxName = inboxes.find((inbox) => inbox.id === defaultInboxId)?.name ?? null

  // The three lists whose order is the SITE's - the shared addresses, the
  // colleagues' inboxes, the channels. One arrangement everybody opens, so
  // arranging them is a job for whoever looks after the place. Yours is the
  // fourth list and is nothing like them: see `orderedMine` below.
  const sharedDraggable = canReorder && shared.length > 1
  const teamDraggable = canReorder && team.length > 1
  const channelsDraggable = canReorder && channelOrder.length > 1

  // One of these per group: a row lifted out of one list must not light up a
  // row in another, and three groups sharing one pair of ids is exactly how
  // that happens.
  const sharedDrag = useRailDrag(sharedDraggable, move)
  const teamDrag = useRailDrag(teamDraggable, move)
  const channelDrag = useRailDrag(channelsDraggable, moveChannel)

  /** One address. `drag` is null for everything under Yours, which sits still.
   *  An individual one says so out loud, because "only you can see this" is
   *  worth knowing before you answer from it and not after. */
  const inboxEntry = (inbox: TabInbox, drag: RailDragState | null): RailItem => ({
    key: inbox.id,
    href: link(inbox.id),
    active: current === inbox.id,
    // An address that is this reader's OWN wears a person rather than one of
    // the five colours. The colours are how a shared address is recognised at a
    // glance among six of them; there is only ever one of these, it is the row
    // they open on every morning, and saying "this one is you" is more use than
    // saying which of five arbitrary tones it happens to hash to.
    //
    // A SHARED address merely pinned to the top keeps its colour: purchasing@ is
    // still the team's, and it is the same address, in the same colour, on
    // everybody else's rail.
    ...(inbox.kind === 'individual' && inbox.ownerUserId === me.id
      ? { icon: AssignedIcon }
      : { tone: toneFor(inbox.id) }),
    name: inbox.name,
    title: drag
      ? inbox.address
      : inbox.kind === 'individual'
        ? `${inbox.address} - yours, and nobody else can see it`
        : `${inbox.address} - your own inbox`,
    count: <Count value={inbox.count} />,
    hint: drag
      ? REORDER_HINT
      : inbox.kind === 'individual'
        ? 'Your own inbox. Nobody else can see it.'
        : 'Your own inbox.',
    dragId: drag ? inbox.id : undefined,
    dragging: drag ? drag.dragId === inbox.id : undefined,
    over: drag ? drag.overId === inbox.id && drag.dragId !== inbox.id : undefined,
  })


  // The default arrangement of the top of the rail, before this person's own
  // order is applied to it.
  //
  // There is no "Assigned to me" here any more. What has been handed to
  // somebody now shows in the address they open on, beside the post that
  // arrived there - which is the screen they are already looking at, rather
  // than a second list they had to remember to go and check. See
  // `alsoAssignedTo` in lib/db.ts for the widening that does it.
  const mineBase: RailItem[] = [
    // Ahead of All, because they are what this person opened the hub to read.
    ...yours.map((inbox) => inboxEntry(inbox, null)),
    {
      key: 'all',
      // Named rather than left out: with an address of their own, an empty
      // inbox param means "take me to mine", so All has to say so out loud.
      href: link('all'),
      active: current === null,
      icon: InboxIcon,
      name: 'All',
      count: <Count value={allCount} />,
    },
    {
      // Being handed a conversation and being asked about one are two different
      // acts - one moves the whole thing onto your desk, the other asks you
      // about a bit of it. The first now lands in the address above; this is
      // the second, and a colleague who only ever gets it would otherwise have
      // nowhere at all to see them.
      key: 'mentions',
      href: link('mentions'),
      active: current === 'mentions',
      icon: AtIcon,
      name: 'Mentioned',
      title: 'Conversations colleagues have tagged you in',
      count: <Count value={askedCount} word="waiting" quiet />,
    },
    ...(showDrafts ? [{
      key: 'drafts',
      href: link('drafts'),
      active: current === 'drafts',
      icon: FileIcon,
      name: 'Drafts',
      title: 'Messages you have started and not sent',
      count: <Count value={draftCount} word="saved" quiet />,
    }] : []),
    // Beside Drafts, because it is the other half of the same pile - written
    // and not gone yet - and because somebody who has just set one going looks
    // for it next to the place unfinished writing lives. It is not IN Drafts:
    // a message with a time on it has been decided about, and a Drafts count
    // that included them read as a list of things still to do.
    ...(showScheduled ? [{
      key: 'scheduled',
      href: link('scheduled'),
      active: current === 'scheduled',
      icon: AlarmIcon,
      name: 'Scheduled',
      title: 'Messages set to go out on their own, and not gone yet',
      count: <Count value={scheduledCount} word="waiting" quiet />,
    }] : []),
    {
      // No count beside it, unlike the addresses: those count conversations
      // still open, and something you have sent is not a job waiting on you.
      key: 'sent',
      href: link('sent'),
      active: current === 'sent',
      icon: SendIcon,
      name: 'Sent',
      // Yours, and it says so. What has left a SHARED address, whoever wrote
      // it, hangs under that address further down the rail - which is where
      // somebody goes to ask "has that quote gone out" rather than "did I send
      // it". A folder under your own name holding a colleague's replies is not
      // your Sent folder at all.
      title: 'Everything you have sent, from your own address and every shared one you write from',
    },
    {
      // Last under Yours, which is where every mail program in the world puts
      // it: a place you go on purpose rather than one you pass through, and the
      // one folder here whose number going up is not good news.
      //
      // Yours alone, and named so. What one person files as junk is what a
      // colleague reads every Tuesday, so nothing here changed anybody else's
      // screen - which is worth saying out loud, because "I marked it as spam"
      // otherwise sounds like something that happened to the whole team.
      //
      // The count is UNREAD junk, not everything in the bin. A total would sit
      // there for good - nobody empties a spam folder - and a number that never
      // changes is a number nobody reads. Still drawn quiet rather than like an
      // address's: something new in the bin is worth noticing, and it is not
      // worth the same amount as something new in the post.
      key: 'spam',
      href: link('spam'),
      active: current === 'spam',
      icon: SpamIcon,
      name: 'Spam',
      title: 'What you have marked as junk. Yours alone - nobody else sees this list.',
      count: <Count value={spamCount} word="unread, marked as junk" quiet />,
    },
  ]

  // ...and the same list in the order this person put it in.
  //
  // The one group on the rail whose order is NOT the site's. The addresses
  // below, the colleagues' inboxes and the channels are one arrangement
  // everybody opens, so arranging them takes the permission that looks after
  // the place. These half-dozen are one person's own working day - somebody who
  // lives in Sent wants it second, somebody who never opens it wants it last -
  // and nobody else's screen changes by a pixel. So it needs no permission at
  // all, and it is saved against the person rather than against the site.
  const orderedMine = sortByStoredOrder(mineBase, mineOrder)
  const mineDraggable = orderedMine.length > 1

  // A plain function rather than a useCallback: the drag hook reads it when a
  // gesture ends and never as a dependency, and the list it closes over is
  // rebuilt on every render anyway, so a memo here would only be a memo the
  // compiler has to reason about.
  const moveMine = (fromKey: string, toKey: string) => {
    const keys = orderedMine.map((item) => item.key)
    const next = moveInOrder(keys, keys.indexOf(fromKey), keys.indexOf(toKey))
    if (next === keys) return
    const previous = mineOrder
    setMineOrder(next)
    // Told ahead of the answer, exactly as the site-wide orders are: a good save
    // asks for a refresh, and a key still describing the old order would take
    // that refresh as somebody else's rearrangement and put the rail back.
    lastMineKey.current = next.join('|')
    void saveOrder(
      '/api/m/unified-inbox/rail-order',
      { keys: next },
      () => {
        lastMineKey.current = previous.join('|')
        setMineOrder(previous)
      },
    )
  }

  const mineDrag = useRailDrag(mineDraggable, moveMine)

  const mine: RailItem[] = orderedMine.map((item) => (mineDraggable ? {
    ...item,
    // Kept rather than replaced: "nobody else can see this one" is worth
    // hearing before you answer from it, and it does not stop being true
    // because the row can also be moved.
    hint: item.hint ? `${item.hint} ${REORDER_HINT}` : REORDER_HINT,
    dragId: item.key,
    dragging: mineDrag.state.dragId === item.key,
    over: mineDrag.state.overId === item.key && mineDrag.state.dragId !== item.key,
  } : item))

  // ---- colleagues' own post -------------------------------------------
  //
  // Named for the person rather than for the address, and opening out into the
  // two folders of theirs that are worth reaching from here. Which is a
  // deliberately short list: their Inbox is the row itself, and Sent and
  // Mentioned are the two a person covering somebody's post actually opens -
  // "has that quote gone out", "what has anybody asked them about". Everything
  // else about the address is still reachable by standing in it.
  //
  // Drafts is here too, and it is THEIRS - the replies Sam started on Sam's own
  // address and has not sent. It reads, and it does not write: opening one shows
  // the words, and nothing on the screen will finish it, because a draft still
  // belongs to whoever wrote it (see canEditDraft in lib/drafts.ts). Somebody
  // who may send from Sam's address can send one out for him exactly as it
  // stands, which is the way out of a finished quote waiting on a fortnight's
  // leave.
  //
  // Reading somebody's unfinished writing is a real thing to hand over, and the
  // gate is the address itself: an individual inbox is only ever visible to its
  // owner and to the people deliberately named on it, who are already reading
  // every message in it. What they could not see was the answer half-written and
  // waiting, which is exactly what makes the same customer get answered twice.
  //
  // The folders are scoped to THAT address in the query string, so nothing
  // under a colleague's name is ever this reader's own list wearing the
  // colleague's name - the panel resolves the id against the addresses this
  // person may read before it fetches a row (E17).

  /** The folders under one colleague. Drafts, Mentioned and the bin only where
   *  there is somebody for them to belong to: an address whose owner's account
   *  has gone belongs to nobody, and a list of what nobody has been asked about,
   *  or half-written, is a heading over an empty box for ever. */
  /** The one folder an address always has: everything that has left it, whoever
   *  wrote it. Under a colleague's name it answers "has Sam's quote gone out";
   *  under a shared address it is the address's own post, which is the only
   *  place the mail a module sent on its own can be read. Both groups use it,
   *  and one of them has nothing else. */
  const sentFolderFor = (inbox: TabInbox): RailItem => ({
    key: `${inbox.id}:sent`,
    href: link(`sent:${inbox.id}`),
    active: current === `sent:${inbox.id}`,
    icon: SendIcon,
    name: 'Sent',
    title: `Everything that has left ${inbox.address}, whoever sent it`,
  })

  const foldersFor = (inbox: TabInbox): RailItem[] => [
    // Ahead of Sent, because it is the half that has not happened yet: somebody
    // covering this address wants to know what is already half-answered before
    // they go and answer it themselves.
    ...(inbox.ownerUserId ? [{
      key: `${inbox.id}:drafts`,
      href: link(`drafts:${inbox.id}`),
      active: current === `drafts:${inbox.id}`,
      icon: FileIcon,
      name: 'Drafts',
      title: `Messages ${inbox.ownerName ?? 'they'} have started on ${inbox.address} and not sent`,
      count: <Count value={draftCounts[inbox.id] ?? 0} word="saved" quiet />,
    }] : []),
    sentFolderFor(inbox),
    ...(inbox.ownerUserId ? [{
      key: `${inbox.id}:mentions`,
      href: link(`mentions:${inbox.id}`),
      active: current === `mentions:${inbox.id}`,
      icon: AtIcon,
      name: 'Mentioned',
      title: `Conversations here that ${inbox.ownerName ?? 'they'} have been tagged in`,
    }] : []),
    // Their bin, and it is here because of where the junk goes rather than as a
    // convenience. Somebody covering this colleague's post is working it on
    // their behalf, so what they throw away lands in THIS colleague's spam
    // folder rather than in their own (see spamOwnerFor). Without somewhere to
    // look at it, a mis-click while covering would be a message only its owner
    // could ever get back.
    //
    // Only where there is an owner - the same guard Mentioned wears just above,
    // and for the same reason. A bin belongs to a person; an address whose
    // colleague's account has gone has nobody whose bin it could be.
    ...(inbox.ownerUserId ? [{
      key: `${inbox.id}:spam`,
      href: link(`spam:${inbox.id}`),
      active: current === `spam:${inbox.id}`,
      icon: SpamIcon,
      name: 'Spam',
      title: `What has been thrown away out of ${inbox.ownerName ?? 'their'} post`,
    }] : []),
  ]

  // Whichever colleague the address bar is already inside, so a link somebody
  // followed to Sam's Sent arrives with Sam's folders showing rather than with
  // the row that would explain where they are collapsed. Worked out from the
  // current entry rather than kept in step with an effect: there is one right
  // answer and it is already on the screen.
  const currentFolderInbox = (() => {
    if (!current) return null
    for (const folder of ['sent', 'drafts', 'mentions', 'spam']) {
      if (current.startsWith(`${folder}:`)) return current.slice(folder.length + 1)
    }
    return null
  })()
  const isOpened = (id: string) => opened.includes(id) || currentFolderInbox === id
  const toggleOpen = (id: string) => setOpened((showing) => (
    showing.includes(id) ? showing.filter((i) => i !== id) : [...showing, id]
  ))

  // The channels another module owns, in whatever order the site has put them
  // in. Keyed by the channel's own key rather than by an inbox id: a channel
  // sits in no inbox, which is rather the point of it.
  const channelEntries: RailItem[] = channelOrder.map((channel) => ({
    key: `m:${channel.key}`,
    href: link(`m:${channel.key}`),
    active: current === `m:${channel.key}`,
    tone: toneFor(channel.key),
    name: channel.label,
    count: <Count value={channel.count} />,
    hint: channelsDraggable ? REORDER_HINT : undefined,
    dragId: channelsDraggable ? channel.key : undefined,
    dragging: channelsDraggable && channelDrag.state.dragId === channel.key,
    over: channelsDraggable
      && channelDrag.state.overId === channel.key
      && channelDrag.state.dragId !== channel.key,
  }))

  const elsewhere: RailItem[] = [
    {
      // The address book rather than the post.
      key: 'contacts',
      href: link('contacts'),
      active: current === 'contacts',
      icon: PeopleIcon,
      name: 'Contacts',
      title: 'Everybody you deal with, and how to reach them',
      count: <Count value={contactCount} word="contacts" quiet />,
    },
    ...(showCampaigns ? [{
      key: 'campaigns',
      href: link('campaigns'),
      active: current === 'campaigns',
      icon: MegaphoneIcon,
      name: 'Campaigns',
      title: 'The same email to a great many people, sent slowly',
    }] : []),
    ...(showUnrouted ? [{
      key: 'none',
      href: link('none'),
      active: current === 'none',
      icon: FolderIcon,
      name: 'Not filed',
      title: 'Mail that reached the account but matched none of your addresses',
      count: <Count value={unroutedCount} />,
    }] : []),
  ]

  // Where the reader is standing, for the bar below 1200px, where the list of
  // places is folded away and something has to say which one is open. A folder
  // under a colleague's name says whose it is, because "Sent" on its own is
  // three people's Sent on a site with three colleagues. All has no entry of
  // its own to be active - it is `current === null` - so the fallback is what
  // the All row says.
  const here = (() => {
    const own = mine.find((item) => item.active)
    if (own) return own
    for (const inbox of shared) {
      const row = inboxEntry(inbox, null)
      if (row.active) return row
      const sent = sentFolderFor(inbox)
      if (sent.active) return { ...sent, name: `${inbox.name} · Sent` }
    }
    for (const inbox of team) {
      const label = inbox.ownerName ?? inbox.name
      const row = inboxEntry(inbox, null)
      if (row.active) return { ...row, name: label }
      const folder = foldersFor(inbox).find((item) => item.active)
      if (folder) return { ...folder, name: `${label} · ${folder.name}` }
    }
    return channelEntries.find((item) => item.active)
      ?? elsewhere.find((item) => item.active)
      ?? null
  })()

  return (
    <nav className="uin-rail" aria-label="Inboxes and views" data-drawer={placesOpen ? 'open' : 'closed'}>
      {/* Who is reading, and the two buttons up here that are not places to
          go. The same arrangement every mail program uses, for the same
          reason: finding something and writing something are acts, and an act
          does not belong in a list of places. Search on the left of the pen,
          because it is the one people reach for oftenest and the one they
          reach for without looking.
          Below 1200px this same row is the bar along the top of the frame, and
          the first thing on it is where you are - press it and the places
          slide in. */}
      <div className="uin-rail-me">
        <button
          type="button"
          className="uin-rail-places"
          ref={placesButton}
          aria-expanded={placesOpen}
          aria-controls="uin-rail-places"
          onClick={placesOpen ? closePlaces : openPlaces}
        >
          <span className="uin-rail-places-lines" aria-hidden="true">{MenuIcon}</span>
          {here?.tone
            ? <span className="uin-rail-dot" data-tone={here.tone} aria-hidden="true" />
            : here?.icon
              ? <span className="uin-rail-icon" aria-hidden="true">{here.icon}</span>
              : null}
          <span className="uin-rail-places-name">{here?.name ?? 'Inbox'}</span>
          {here?.count}
          <span className="uin-rail-places-chevron" aria-hidden="true">{ChevronDownIcon}</span>
          <span className="sr-only">. Choose an inbox or a view</span>
        </button>
        <Avatar src={showAvatars ? avatarHref('user', me.id) : null} title={me.name}>
          {initialsFor(me.name)}
        </Avatar>
        <span className="uin-rail-me-name">{me.name}</span>
        <InboxSearch
          base={base}
          params={params}
          inboxes={inboxes.map((inbox) => ({ id: inbox.id, name: inbox.name }))}
          channels={channelOrder.map((channel) => ({
            key: channel.key,
            label: channel.label,
          }))}
          showUnrouted={showUnrouted}
        />
        {composeHref && (
          <ComposeMenu composeHref={composeHref} entries={composeEntries} />
        )}
      </div>

      {/* The dimmed page behind the open drawer, and the press that shuts it.
          Only in the markup while the drawer is out, so a screen reader never
          meets a button that does nothing. */}
      {placesOpen && (
        <button
          type="button"
          className="uin-rail-backdrop"
          aria-label="Close the list of inboxes"
          tabIndex={-1}
          onClick={closePlaces}
        />
      )}

      {/* Everything that is a place to go, in one box. It is a column on a wide
          window and a drawer that slides in from the left on anything narrower.
          The box at the foot of it is stuck there rather than sitting at the
          end of the list, so when the post last arrived - and whatever the last
          press had to say - is on screen without anybody scrolling for it. */}
      <div className="uin-rail-scroll" id="uin-rail-places" onClick={onDrawerClick}>
        {/* The drawer's own head. Who is reading, which the bar outside has no
            room to say, and the way out. Not drawn as anything above 1200px. */}
        <div className="uin-rail-drawer-head">
          <Avatar src={showAvatars ? avatarHref('user', me.id) : null} title={me.name}>
            {initialsFor(me.name)}
          </Avatar>
          <span className="uin-rail-me-name">{me.name}</span>
          <button
            type="button"
            className="uin-modal-close uin-rail-drawer-close"
            ref={drawerClose}
            aria-label="Close the list of inboxes"
            onClick={closePlaces}
          >
            {CloseIcon}
          </button>
        </div>

        <div className="uin-rail-group">
          <p className="uin-rail-heading" id="uin-rail-mine">Yours</p>
          <ul className="uin-rail-list" aria-labelledby="uin-rail-mine" {...mineDrag.handlers}>
            {mine.map((item) => <Entry key={item.key} item={item} />)}
          </ul>
        </div>

        {shared.length > 0 && (
          <div className="uin-rail-group">
            <p className="uin-rail-heading" id="uin-rail-team">Shared inboxes</p>
            <ul className="uin-rail-list" aria-labelledby="uin-rail-team" {...sharedDrag.handlers}>
              {/* One folder each, and it is the one the rail could not otherwise
                  reach. Sent under Yours is now this reader's own writing, so
                  everything that left sales@ - a colleague's reply, an order
                  confirmation no person typed - is read here, under the address
                  it belongs to. Nothing else hangs under a shared name: a bin
                  and a Mentioned list belong to a PERSON, and a shared address
                  is nobody. */}
              {shared.map((inbox) => (
                <Branch
                  key={inbox.id}
                  id={inbox.id}
                  item={inboxEntry(inbox, sharedDraggable ? sharedDrag.state : null)}
                  opens={`the Sent folder under ${inbox.name}`}
                  folders={[sentFolderFor(inbox)]}
                  open={isOpened(inbox.id)}
                  onToggle={() => toggleOpen(inbox.id)}
                />
              ))}
            </ul>
          </div>
        )}

        {team.length > 0 && (
          <div className="uin-rail-group">
            <p className="uin-rail-heading" id="uin-rail-people">Team inboxes</p>
            <ul className="uin-rail-list" aria-labelledby="uin-rail-people" {...teamDrag.handlers}>
              {team.map((inbox) => {
                // The colleague's name, falling back to the address's own when
                // the account behind it has gone: an address that belongs to
                // nobody is still somewhere an administrator has to be able to
                // reach, and calling it "Unknown" would be worse than calling it
                // what it is.
                const label = inbox.ownerName ?? inbox.name
                const item = inboxEntry(inbox, teamDraggable ? teamDrag.state : null)
                return (
                  <Branch
                    key={inbox.id}
                    id={inbox.id}
                    item={{
                      ...item,
                      // Named for the person rather than for the address, which
                      // is how anybody covering Sam's post thinks of it.
                      name: label,
                      title: `${inbox.address} - ${label}'s own post, shared with you`,
                      hint: teamDraggable ? REORDER_HINT : undefined,
                    }}
                    opens={`the folders under ${label}`}
                    folders={foldersFor(inbox)}
                    open={isOpened(inbox.id)}
                    onToggle={() => toggleOpen(inbox.id)}
                  />
                )
              })}
            </ul>
          </div>
        )}

        {channelEntries.length > 0 && (
          <div className="uin-rail-group">
            <p className="uin-rail-heading" id="uin-rail-channels">Channels</p>
            <ul className="uin-rail-list" aria-labelledby="uin-rail-channels" {...channelDrag.handlers}>
              {channelEntries.map((item) => <Entry key={item.key} item={item} />)}
            </ul>
          </div>
        )}

        <div className="uin-rail-group">
          <p className="uin-rail-heading" id="uin-rail-elsewhere">Everything else</p>
          <ul className="uin-rail-list" aria-labelledby="uin-rail-elsewhere">
            {elsewhere.map((item) => <Entry key={item.key} item={item} />)}
          </ul>
        </div>

        {/* The box stuck to the foot of the rail. Two things live in it and they
            are not the same thing: fetching mail on the spot, which takes the
            permission and a mail account to fetch from, and asking the browser
            to nudge somebody when post arrives, which anybody who can read the
            hub can have. It used to be gated as one, which meant a site whose
            only channels are a chat widget and an enquiry form - no mail
            account anywhere - had no bell at all. */}
        <div className="uin-rail-foot" data-bare={!canCheckNow && !bellShown ? '1' : undefined}>
          {/* Whatever the check came back with, in the box the button lives in
              rather than off under the rail: it is the answer to a press
              somebody has just made, and it is beside the thing they pressed.
              Three seconds, then it fades. */}
          {canCheckNow && notice && (
            <div
              key={noticeSeq}
              className="uin-rail-notice"
              data-fade={notice.tone === 'ok' ? '1' : undefined}
            >
              <div className={`alert ${notice.tone === 'ok' ? 'alert-info' : 'alert-danger'}`} role="status">
                {notice.text}
              </div>
            </div>
          )}
          <div className="uin-rail-foot-row">
            {/* When the post last arrived, which is the question the button
                beside it answers. Stuck to the bottom of the rail so it can be
                read without scrolling forty conversations to find it. */}
            {canCheckNow && (
              <span className="uin-rail-updated">Updated: {updatedLabel(checkedAt, timezone)}</span>
            )}
            <NewMailNotifier
              userId={me.id}
              scopeName={ownInboxName}
              listHref={link(defaultInboxId)}
              threadHref={(threadId) => link(defaultInboxId, { id: threadId })}
              onAvailable={setBellShown}
            />
            {canCheckNow && (
              <CheckNowButton
                onResult={showNotice}
                onChecked={setOwnCheckedAt}
                autoSeconds={autoCheckSeconds}
              />
            )}
          </div>
        </div>
      </div>

      {/* Whatever a refused rearrangement had to say. It is the answer to a
          gesture somebody has just made, so it belongs beside the rail rather
          than at the top of the screen. */}
      {error && (
        <div className="uin-rail-notice">
          <div className="alert alert-danger" role="alert">{error}</div>
        </div>
      )}
    </nav>
  )
}
