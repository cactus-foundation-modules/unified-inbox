'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { avatarHref, inboxHref, initialsFor, moveInOrder, splitInboxes } from '@/modules/unified-inbox/lib/list'
import {
  AssignedIcon, AtIcon, ChevronRightIcon, FileIcon, FolderIcon, InboxIcon, MegaphoneIcon,
  PeopleIcon, SendIcon,
} from './icons'
import { Avatar } from './Avatar'
import { CheckNowButton, type CheckNowNotice } from './CheckNowButton'
import { InboxSearch } from './InboxSearch'
import { ComposeMenu, type ComposeMenuEntry } from './ComposeMenu'

// Everywhere you can go, down the left.
//
// It was a strip of tabs across the top, which is where a browser puts three of
// something. There are a dozen here on a site with a handful of addresses, and
// a dozen tabs is a horizontal scrollbar with half of them behind it. A rail is
// what every mail program in the world uses for the same list, it reads down in
// one go, and it leaves the width of the screen to the thing somebody came here
// to read. Below 1200px there is not room for a column of it, and it lies down
// into one scrolling strip again - same markup, same order, no second
// component.
//
// FIVE GROUPS, and the split is the useful one rather than the tidy one.
// "Yours" is the handful of places one person opens all day - their own
// address, everything at once, what has been handed to them, what they have
// been tagged in, what they have half-written and what they have sent. "Shared
// inboxes" is the addresses the business owns, which is where a colour beside
// each name earns its keep: on a site with six of them the name is read second
// and the colour first. "Team inboxes" is colleagues' own post this person has
// been let in to - covering somebody's mail while they are away, working their
// diary - and each one opens out into that colleague's Sent and Mentioned. Then the channels another module owns, then the three screens that
// are not a list of post at all.
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
// is how anybody covering Sam's post thinks of it and "sam@" is not. It cannot
// be dragged: where it sits is decided by whose it is.
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
// The addresses can still be dragged into the order somebody wants them in.
// Dropping saves straight away and the rail moves first: the gesture is over in
// half a second and a list that snaps back while a request finishes reads as a
// bug. A refused save puts the order back and says so.

export type TabInbox = {
  id: string
  name: string
  address: string
  /** Whose post it is. Decides which of the three groups it sits in, and whether
   *  it can be dragged: an individual address is where it is because of what it is,
   *  not because of where somebody put it. */
  kind: 'individual' | 'shared'
  /** Which colleague's, on an individual one. Null on a shared address, and
   *  null on an individual one whose owner's account has gone - which is why
   *  the group below falls back to the address's own name rather than assuming
   *  there is a person to name. */
  ownerUserId: string | null
  ownerName: string | null
  count: number
}
export type TabChannel = { moduleName: string; label: string; count: number }

type Props = {
  base: string
  params: Record<string, string>
  inboxes: TabInbox[]
  channels: TabChannel[]
  /** Every unread conversation this person can see, for the All entry. */
  allCount: number
  /** Which entry is on: an inbox id, `m:<module>`, 'none', 'drafts', 'sent',
   *  'contacts', 'campaigns', 'mentions', one of `sent:<inbox id>` /
   *  `drafts:<inbox id>` / `mentions:<inbox id>` for a folder under a
   *  colleague's name, or null for All. */
  current: string | null
  /** Who is reading, for the picture and initials at the head of the rail, and
   *  for what "assigned to me" means. */
  me: { id: string; name: string }
  /** Whether to ask for their own picture at all. Off unless the site has
   *  switched it on - see Settings, People. */
  showAvatars: boolean
  /** Conversations sitting on this person's own desk, across every address they
   *  can read. */
  assignedCount: number
  /** Things colleagues have tagged this person in and that they have not dealt
   *  with yet. Open only: something set aside until Thursday is not waiting, and
   *  a number that counts it makes the place look busier than it is. */
  askedCount: number
  /** Who the list is currently filtered to, so "Assigned to me" can say whether
   *  it is the thing being looked at. */
  assignee: string | null
  /** How many people are in the address book, beside Contacts. */
  contactCount: number
  /** Whether this person may write campaigns. Its own grant: somebody who may
   *  rename a folder is not, by that fact, somebody who may email five thousand
   *  customers. */
  showCampaigns: boolean
  /** Whether conversations that landed in no inbox are this person's to see. */
  showUnrouted: boolean
  unroutedCount: number
  /** Whether Drafts is worth offering: somebody who can write from nowhere and
   *  has nothing put down half-written has no use for it. */
  showDrafts: boolean
  draftCount: number
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
function Count({ value, word = 'unread', quiet = false }: { value: number; word?: string; quiet?: boolean }) {
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
      </Link>
    </li>
  )
}

export function NavRail({
  base, params, inboxes, channels, allCount, current, me, showAvatars, assignedCount, askedCount, assignee,
  showUnrouted, unroutedCount, showDrafts, draftCount, contactCount, showCampaigns, composeHref,
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
  // Which colleagues' folders are showing. Held here rather than in the address
  // because it is furniture rather than a place: opening Sam's folders is not
  // somewhere to send a colleague a link to, and putting it in the query string
  // would make every list below reload to draw three static rows.
  const [opened, setOpened] = useState<string[]>([])
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [error, setError] = useState('')

  // When a check this page ran actually opened the accounts, or null until one
  // has. Held beside what the server said rather than replacing it, and the
  // newer of the two is what gets read below: a refresh carrying an older
  // figure - one account checked while another was not - cannot then wind the
  // clock back.
  const [ownCheckedAt, setOwnCheckedAt] = useState<number | null>(null)
  const checkedAt = Math.max(lastCheckedAt ?? 0, ownCheckedAt ?? 0) || null

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

  const save = useCallback(async (next: TabInbox[], previous: TabInbox[]) => {
    setError('')
    try {
      const response = await fetch('/api/m/unified-inbox/admin/inboxes/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: next.map((i) => i.id) }),
      })
      if (!response.ok) {
        setOrder(previous)
        setError((await response.json().catch(() => null))?.error ?? 'That order did not save.')
        return
      }
      lastServerKey.current = next.map((i) => `${i.id}:${i.count}`).join('|')
      router.refresh()
    } catch {
      setOrder(previous)
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
  const move = useCallback((fromId: string, toId: string) => {
    const next = moveInOrder(
      order,
      order.findIndex((i) => i.id === fromId),
      order.findIndex((i) => i.id === toId),
    )
    if (next === order) return
    setOrder(next)
    void save(next, order)
  }, [order, save])

  // Changing where you are always goes back to page one, drops whichever
  // conversation was open - it belongs to the list being left - and lets go of
  // "assigned to me", which is a place of its own in this rail rather than a
  // filter that follows you around.
  const link = (inbox: string | null, changes: Record<string, string | null> = {}) =>
    inboxHref(base, params, {
      inbox, page: null, id: null, person: null, compose: null, draft: null, assignee: null,
      // The address book's own params go with the entry that owns them. Left on,
      // an organisation card stayed pinned open beside the morning's post.
      org: null, view: null, edit: null, import: null, cat: null,
      ...changes,
    })

  // Only the addresses in the shared list can be dragged, and the ones under
  // Yours are not among them: they are where they are because of whose they
  // are, not because of the order.
  const draggable = canReorder && shared.length > 1

  /** One address. `movable` is false for everything under Yours, which sits
   *  still. An individual one says so out loud, because "only you can see this"
   *  is worth knowing before you answer from it and not after. */
  const inboxEntry = (inbox: TabInbox, movable: boolean): RailItem => ({
    key: inbox.id,
    href: link(inbox.id),
    active: current === inbox.id,
    tone: toneFor(inbox.id),
    name: inbox.name,
    title: movable
      ? inbox.address
      : inbox.kind === 'individual'
        ? `${inbox.address} - yours, and nobody else can see it`
        : `${inbox.address} - your own inbox`,
    count: <Count value={inbox.count} />,
    hint: movable
      ? 'Hold Alt and press the up or down arrow keys to move it along the rail.'
      : inbox.kind === 'individual'
        ? 'Your own inbox. Nobody else can see it.'
        : 'Your own inbox.',
    dragId: movable ? inbox.id : undefined,
    dragging: movable && dragId === inbox.id,
    over: movable && overId === inbox.id && dragId !== inbox.id,
  })

  /** Which address the pointer is over, off the element under it. The drag is
   *  hung on the list rather than on each of its rows: fourteen addresses is
   *  fourteen sets of five handlers, all of them saying the same thing, and one
   *  set that asks the DOM what it landed on says it once. */
  const addressUnder = (event: React.DragEvent<HTMLElement>): string | null =>
    (event.target as HTMLElement).closest<HTMLElement>('[data-uin-id]')?.dataset.uinId ?? null

  const onDragStart = (event: React.DragEvent<HTMLUListElement>) => {
    const id = addressUnder(event)
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
    const id = addressUnder(event)
    if (!id) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setOverId(id)
  }
  const onDragLeave = (event: React.DragEvent<HTMLUListElement>) => {
    const id = addressUnder(event)
    if (id) setOverId((c) => (c === id ? null : c))
  }
  const onDrop = (event: React.DragEvent<HTMLUListElement>) => {
    const id = addressUnder(event)
    if (!dragId || !id) return
    event.preventDefault()
    const from = dragId
    setDragId(null)
    setOverId(null)
    move(from, id)
  }
  const onDragEnd = () => { setDragId(null); setOverId(null) }

  // Alt and an arrow key does what dragging does, because a rearrangement only a
  // mouse can perform is a rearrangement some people cannot perform at all. The
  // handler sits on the team list, which holds nothing but movable addresses -
  // so the index of a link in it IS the position of that address, and there is
  // no offset to keep in step with the order of the rail any more.
  const onAddressKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    if (!draggable || !event.altKey) return
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    // Held in a local: React empties currentTarget the moment the handler
    // returns, and the focus below happens a frame later.
    const list = event.currentTarget
    const links = Array.from(list.querySelectorAll<HTMLAnchorElement>('a[href]'))
    const index = links.indexOf((event.target as HTMLElement).closest('a') as HTMLAnchorElement)
    if (index < 0 || index >= shared.length) return
    const to = event.key === 'ArrowUp' ? index - 1 : index + 1
    if (to < 0 || to >= shared.length) return
    event.preventDefault()
    move(shared[index]!.id, shared[to]!.id)
    // The keyboard follows the address it just moved, so a second press carries
    // on from where it is rather than from whatever landed under the cursor.
    requestAnimationFrame(() => {
      list.querySelectorAll<HTMLAnchorElement>('a[href]')[to]?.focus()
    })
  }

  const mine: RailItem[] = [
    // Ahead of All, because they are what this person opened the hub to read.
    ...yours.map((inbox) => inboxEntry(inbox, false)),
    {
      key: 'all',
      // Named rather than left out: with an address of their own, an empty
      // inbox param means "take me to mine", so All has to say so out loud.
      href: link('all'),
      active: current === null && !assignee,
      icon: InboxIcon,
      name: 'All',
      count: <Count value={allCount} />,
    },
    {
      // A place rather than a filter chip. "What is on my desk" is the first
      // question of the morning on any shared address, and it was a dropdown
      // and two presses away.
      key: 'assigned',
      href: link('all', { assignee: me.id }),
      active: assignee === me.id,
      icon: AssignedIcon,
      name: 'Assigned to me',
      title: 'Conversations handed to you, across every address you can read',
      count: <Count value={assignedCount} word="waiting" quiet />,
    },
    {
      // Beside "Assigned to me", because it answers the other half of the same
      // question. Being handed a conversation and being asked about one are two
      // different acts - one moves the whole thing onto your desk, the other
      // asks you about a bit of it - and a colleague who only ever gets the
      // second had nowhere at all to see them.
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
    {
      // No count beside it, unlike the addresses: the counts are of
      // conversations nobody has read yet, and nothing you sent yourself is
      // waiting to be read by you.
      key: 'sent',
      href: link('sent'),
      active: current === 'sent',
      icon: SendIcon,
      name: 'Sent',
      title: 'Everything that has left, from every address you can read',
    },
  ]

  // ---- colleagues' own post -------------------------------------------
  //
  // Named for the person rather than for the address, and opening out into the
  // two folders of theirs that are worth reaching from here. Which is a
  // deliberately short list: their Inbox is the row itself, and Sent and
  // Mentioned are the two a person covering somebody's post actually opens -
  // "has that quote gone out", "what has anybody asked them about". Everything
  // else about the address is still reachable by standing in it.
  //
  // No Drafts. A draft belongs to whoever wrote it (see lib/drafts.ts), so a
  // folder under somebody else's name could only ever hold this reader's own
  // writing, under a heading saying it was theirs.
  //
  // The folders are scoped to THAT address in the query string, so nothing
  // under a colleague's name is ever this reader's own list wearing the
  // colleague's name - the panel resolves the id against the addresses this
  // person may read before it fetches a row (E17).

  /** The folders under one colleague. Mentioned only where there is somebody to
   *  have been mentioned: an address whose owner's account has gone belongs to
   *  nobody, and a list of what nobody has been asked about is a heading over an
   *  empty box for ever. */
  const foldersFor = (inbox: TabInbox): RailItem[] => [
    {
      key: `${inbox.id}:sent`,
      href: link(`sent:${inbox.id}`),
      active: current === `sent:${inbox.id}`,
      icon: SendIcon,
      name: 'Sent',
      title: `Everything that has left ${inbox.address}`,
    },
    ...(inbox.ownerUserId ? [{
      key: `${inbox.id}:mentions`,
      href: link(`mentions:${inbox.id}`),
      active: current === `mentions:${inbox.id}`,
      icon: AtIcon,
      name: 'Mentioned',
      title: `Conversations here that ${inbox.ownerName ?? 'they'} have been tagged in`,
    }] : []),
  ]

  // Whichever colleague the address bar is already inside, so a link somebody
  // followed to Sam's Sent arrives with Sam's folders showing rather than with
  // the row that would explain where they are collapsed. Worked out from the
  // current entry rather than kept in step with an effect: there is one right
  // answer and it is already on the screen.
  const currentFolderInbox = (() => {
    if (!current) return null
    for (const folder of ['sent', 'drafts', 'mentions']) {
      if (current.startsWith(`${folder}:`)) return current.slice(folder.length + 1)
    }
    return null
  })()
  const isOpened = (id: string) => opened.includes(id) || currentFolderInbox === id
  const toggleOpen = (id: string) => setOpened((showing) => (
    showing.includes(id) ? showing.filter((i) => i !== id) : [...showing, id]
  ))

  const channelEntries: RailItem[] = channels.map((channel) => ({
    key: `m:${channel.moduleName}`,
    href: link(`m:${channel.moduleName}`),
    active: current === `m:${channel.moduleName}`,
    tone: toneFor(channel.moduleName),
    name: channel.label,
    count: <Count value={channel.count} />,
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

  return (
    <nav className="uin-rail" aria-label="Inboxes and views">
      {/* Everything that is a place to go, in one box. It is a column on a wide
          window and one scrolling strip on anything narrower. The box at the
          foot of it is stuck there rather than sitting at the end of the list,
          so when the post last arrived - and whatever the last press had to say
          - is on screen without anybody scrolling for it. */}
      <div className="uin-rail-scroll">
        {/* Who is reading, and the two buttons up here that are not places to
            go. The same arrangement every mail program uses, for the same
            reason: finding something and writing something are acts, and an act
            does not belong in a list of places. Search on the left of the pen,
            because it is the one people reach for oftenest and the one they
            reach for without looking. */}
        <div className="uin-rail-me">
          <Avatar src={showAvatars ? avatarHref('user', me.id) : null} title={me.name}>
            {initialsFor(me.name)}
          </Avatar>
          <span className="uin-rail-me-name">{me.name}</span>
          <InboxSearch
            base={base}
            params={params}
            inboxes={inboxes.map((inbox) => ({ id: inbox.id, name: inbox.name }))}
            channels={channels.map((channel) => ({
              moduleName: channel.moduleName,
              label: channel.label,
            }))}
            showUnrouted={showUnrouted}
          />
          {composeHref && (
            <ComposeMenu composeHref={composeHref} entries={composeEntries} />
          )}
        </div>

        <div className="uin-rail-group">
          <p className="uin-rail-heading" id="uin-rail-mine">Yours</p>
          <ul className="uin-rail-list" aria-labelledby="uin-rail-mine">
            {mine.map((item) => <Entry key={item.key} item={item} />)}
          </ul>
        </div>

        {shared.length > 0 && (
          <div className="uin-rail-group">
            <p className="uin-rail-heading" id="uin-rail-team">Shared inboxes</p>
            <ul
              className="uin-rail-list"
              aria-labelledby="uin-rail-team"
              onKeyDown={onAddressKeyDown}
              onDragStart={draggable ? onDragStart : undefined}
              onDragOver={draggable ? onDragOver : undefined}
              onDragLeave={draggable ? onDragLeave : undefined}
              onDrop={draggable ? onDrop : undefined}
              onDragEnd={draggable ? onDragEnd : undefined}
            >
              {shared.map((inbox) => (
                <Entry key={inbox.id} item={inboxEntry(inbox, draggable)} />
              ))}
            </ul>
          </div>
        )}

        {team.length > 0 && (
          <div className="uin-rail-group">
            <p className="uin-rail-heading" id="uin-rail-people">Team inboxes</p>
            <ul className="uin-rail-list" aria-labelledby="uin-rail-people">
              {team.map((inbox) => {
                // The colleague's name, falling back to the address's own when
                // the account behind it has gone: an address that belongs to
                // nobody is still somewhere an administrator has to be able to
                // reach, and calling it "Unknown" would be worse than calling it
                // what it is.
                const label = inbox.ownerName ?? inbox.name
                const open = isOpened(inbox.id)
                return (
                  <li key={inbox.id}>
                    <div className="uin-rail-branch">
                      {/* Outside the link rather than inside it, because a
                          control inside a link is one you cannot press without
                          going where the link goes. */}
                      <button
                        type="button"
                        className="uin-rail-twist"
                        aria-expanded={open}
                        aria-controls={`uin-rail-folders-${inbox.id}`}
                        onClick={() => toggleOpen(inbox.id)}
                      >
                        <span className="uin-rail-twist-icon" aria-hidden="true">{ChevronRightIcon}</span>
                        <span className="sr-only">
                          {open ? `Hide ${label}'s folders` : `Show ${label}'s folders`}
                        </span>
                      </button>
                      <Link
                        className="uin-rail-item"
                        href={link(inbox.id)}
                        aria-current={current === inbox.id ? 'page' : undefined}
                        title={`${inbox.address} - ${label}'s own post, shared with you`}
                      >
                        <span className="uin-rail-dot" data-tone={toneFor(inbox.id)} aria-hidden="true" />
                        <span className="uin-rail-name">{label}</span>
                        <Count value={inbox.count} />
                      </Link>
                    </div>
                    {/* Hidden rather than unmounted, so the button above always
                        controls something that exists. */}
                    <ul
                      id={`uin-rail-folders-${inbox.id}`}
                      className="uin-rail-list uin-rail-sub"
                      hidden={!open}
                    >
                      {foldersFor(inbox).map((item) => <Entry key={item.key} item={item} />)}
                    </ul>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {channelEntries.length > 0 && (
          <div className="uin-rail-group">
            <p className="uin-rail-heading" id="uin-rail-channels">Channels</p>
            <ul className="uin-rail-list" aria-labelledby="uin-rail-channels">
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

        {canCheckNow && (
          <div className="uin-rail-foot">
            {/* Whatever the check came back with, in the box the button lives in
                rather than off under the rail: it is the answer to a press
                somebody has just made, and it is beside the thing they pressed.
                Three seconds, then it fades. */}
            {notice && (
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
              <span className="uin-rail-updated">Updated: {updatedLabel(checkedAt, timezone)}</span>
              <CheckNowButton
                onResult={showNotice}
                onChecked={setOwnCheckedAt}
                autoSeconds={autoCheckSeconds}
              />
            </div>
          </div>
        )}
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
