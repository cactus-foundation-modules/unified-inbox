'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { avatarHref, inboxHref, initialsFor, moveInOrder, pinDefaultInbox } from '@/modules/unified-inbox/lib/list'
import {
  AssignedIcon, FileIcon, FolderIcon, InboxIcon, MegaphoneIcon, PenIcon, PeopleIcon, SendIcon,
} from './icons'
import { Avatar } from './Avatar'
import { CheckNowButton, type CheckNowNotice } from './CheckNowButton'

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
// FOUR GROUPS, and the split is the useful one rather than the tidy one.
// "Yours" is the handful of places one person opens all day - their own
// address, everything at once, what has been handed to them, what they have
// half-written and what they have sent. "Team inboxes" is the shared addresses,
// which is where a colour beside each name earns its keep: on a site with six
// of them the name is read second and the colour first. Then the channels
// another module owns, then the three screens that are not a list of post at
// all.
//
// The pinned address is the one exception to the rail being the same for
// everybody. It is first, under Yours, because it is what that person opens the
// hub for - and All stays right under it rather than going away, because
// somebody who works purchasing@ still wants to see the lot without hunting.
//
// Unread counts ride beside the names, because "is there anything new in
// accounts@" is the question this rail is answering.
//
// Fetching new mail sits at the foot of it, under a rule: "has anything come
// in" is asked of the whole screen rather than of one address, and it is a
// thing to do rather than a place to go.
//
// The addresses can still be dragged into the order somebody wants them in.
// Dropping saves straight away and the rail moves first: the gesture is over in
// half a second and a list that snaps back while a request finishes reads as a
// bug. A refused save puts the order back and says so.

export type TabInbox = { id: string; name: string; address: string; count: number }
export type TabChannel = { moduleName: string; label: string; count: number }

type Props = {
  base: string
  params: Record<string, string>
  inboxes: TabInbox[]
  channels: TabChannel[]
  /** Every unread conversation this person can see, for the All entry. */
  allCount: number
  /** Which entry is on: an inbox id, `m:<module>`, 'none', 'drafts', 'sent',
   *  'contacts', 'campaigns', or null for All. */
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
  base, params, inboxes, channels, allCount, current, me, showAvatars, assignedCount, assignee,
  showUnrouted, unroutedCount, showDrafts, draftCount, contactCount, showCampaigns, composeHref,
  defaultInboxId, canReorder, canCheckNow, autoCheckSeconds,
}: Props) {
  const router = useRouter()
  const [notice, setNotice] = useState<CheckNowNotice | null>(null)
  const [order, setOrder] = useState(inboxes)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [error, setError] = useState('')

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

  // This person's own address, out in front, and everything else in the order
  // the site keeps. Both halves are worked out from one list so the drag below
  // can talk in one and save in the other.
  const { pinned, rest } = pinDefaultInbox(order, defaultInboxId)

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

  // Only the addresses that are actually in the team list can be dragged, and
  // the pinned one is not one of them: it is where it is because it is this
  // person's, not because of the order.
  const draggable = canReorder && rest.length > 1

  /** One address. `movable` is false for the pinned one, which sits still. */
  const inboxEntry = (inbox: TabInbox, movable: boolean): RailItem => ({
    key: inbox.id,
    href: link(inbox.id),
    active: current === inbox.id,
    tone: toneFor(inbox.id),
    name: inbox.name,
    title: movable ? inbox.address : `${inbox.address} - your own inbox`,
    count: <Count value={inbox.count} />,
    hint: movable
      ? 'Hold Alt and press the up or down arrow keys to move it along the rail.'
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
    if (index < 0 || index >= rest.length) return
    const to = event.key === 'ArrowUp' ? index - 1 : index + 1
    if (to < 0 || to >= rest.length) return
    event.preventDefault()
    move(rest[index]!.id, rest[to]!.id)
    // The keyboard follows the address it just moved, so a second press carries
    // on from where it is rather than from whatever landed under the cursor.
    requestAnimationFrame(() => {
      list.querySelectorAll<HTMLAnchorElement>('a[href]')[to]?.focus()
    })
  }

  const mine: RailItem[] = [
    // Ahead of All, because it is what this person opened the hub to read.
    ...(pinned ? [inboxEntry(pinned, false)] : []),
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
          window and one scrolling strip on anything narrower; the notices below
          stay outside it either way, so an answer to a press is never parked
          off the end of a strip nobody has scrolled. */}
      <div className="uin-rail-scroll">
        {/* Who is reading, and the one button up here that is not a place to go.
            The same arrangement every mail program uses, for the same reason:
            writing something is an act, and an act does not belong in a list of
            places. */}
        <div className="uin-rail-me">
          <Avatar src={showAvatars ? avatarHref('user', me.id) : null} title={me.name}>
            {initialsFor(me.name)}
          </Avatar>
          <span className="uin-rail-me-name">{me.name}</span>
          {composeHref && (
            <Link className="uin-rail-compose" href={composeHref} aria-label="Write a message">
              {PenIcon}
            </Link>
          )}
        </div>

        <div className="uin-rail-group">
          <p className="uin-rail-heading" id="uin-rail-mine">Yours</p>
          <ul className="uin-rail-list" aria-labelledby="uin-rail-mine">
            {mine.map((item) => <Entry key={item.key} item={item} />)}
          </ul>
        </div>

        {rest.length > 0 && (
          <div className="uin-rail-group">
            <p className="uin-rail-heading" id="uin-rail-team">Team inboxes</p>
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
              {rest.map((inbox) => (
                <Entry key={inbox.id} item={inboxEntry(inbox, draggable)} />
              ))}
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
            <CheckNowButton onResult={setNotice} autoSeconds={autoCheckSeconds} />
          </div>
        )}
      </div>

      {/* Whatever the check came back with, and whatever a refused rearrangement
          had to say. Both are answers to a press somebody has just made, so they
          belong beside the thing that was pressed rather than at the top of the
          screen. */}
      {notice && (
        <div className="uin-rail-notice">
          <div className={`alert ${notice.tone === 'ok' ? 'alert-info' : 'alert-danger'}`} role="status">
            {notice.text}
          </div>
        </div>
      )}
      {error && (
        <div className="uin-rail-notice">
          <div className="alert alert-danger" role="alert">{error}</div>
        </div>
      )}
    </nav>
  )
}
