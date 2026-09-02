'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { TabStrip } from '@/components/admin/TabStrip'
import { inboxHref, moveInOrder, pinDefaultInbox } from '@/modules/unified-inbox/lib/list'
import { PenIcon } from './icons'
import { CheckNowButton, type CheckNowNotice } from './CheckNowButton'

// What the list is a list of, along the top: this person's own address if they
// have been given one, then everything at once, then each address people write
// to, then the channels another module owns, then Sent and Drafts where a mail
// program has kept them for thirty years, and last of all mail nobody could
// file - which only an administrator sees at all.
//
// The pinned address is the one exception to the row being the same for
// everybody. It is first because it is what that person opens the hub for, and
// All is second rather than gone: somebody who works purchasing@ still wants to
// see the lot without hunting for it.
//
// It is core's tab strip rather than a rail of this module's own, so the inbox
// arrives looking like every other admin screen with tabs and scrolls its own
// overflow on a narrow window instead of eating a column of the reading area.
// Unread counts ride in the labels, because "is there anything new in
// accounts@" is the question this row is answering.
//
// Fetching new mail sits at the head of the row, to the left of All, because
// "has anything come in" is asked of the whole screen rather than of one
// address. It is outside core's strip rather than in it: the strip takes tabs
// and one trailing slot, and this is neither. See .uin-tabrow in styles.tsx for
// how the line under the addresses is made to run unbroken across it.
//
// The addresses can still be dragged into the order somebody wants them in.
// The strip belongs to core, so the drag lives on the label inside each tab -
// which is stretched back over the tab's own padding, so taking hold anywhere
// on an address picks it up rather than picking up its link. Dropping saves
// straight away and the strip moves first: the gesture is over in half a second
// and a row that snaps back while a request finishes reads as a bug. A refused
// save puts the order back and says so.

export type TabInbox = { id: string; name: string; address: string; count: number }
export type TabChannel = { moduleName: string; label: string; count: number }

type Props = {
  base: string
  params: Record<string, string>
  inboxes: TabInbox[]
  channels: TabChannel[]
  /** Every unread conversation this person can see, for the All tab. */
  allCount: number
  /** Which tab is on: an inbox id, `m:<module>`, 'none', 'drafts', or null for All. */
  current: string | null
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
  /** The address this person calls their own, pinned to the front of the row,
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

function Count({ value, word = 'unread' }: { value: number; word?: string }) {
  if (!value) return null
  return (
    <span className="uin-tab-count">
      {/* Same ceiling as the status counts below. Two thresholds on one visual
          chip is one too many. */}
      {value > 999 ? '999+' : value}
      <span className="sr-only"> {word}</span>
    </span>
  )
}

export function InboxTabs({
  base, params, inboxes, channels, allCount, current, showUnrouted, unroutedCount,
  showDrafts, draftCount, composeHref, defaultInboxId, canReorder, canCheckNow,
  autoCheckSeconds,
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

  // Said in addresses rather than in positions, because the row as it is drawn
  // and the order the site keeps are two different lists the moment anything is
  // pinned. Resolving against the site's own order here is what keeps the
  // pinned address exactly where it was in it - pinning is one person's
  // preference and must not rearrange the row for everybody else.
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

  // Changing tab always goes back to page one and drops whichever conversation
  // was open - it belongs to the tab being left.
  const link = (inbox: string | null) =>
    inboxHref(base, params, { inbox, page: null, id: null, person: null, compose: null, draft: null })

  // Only the addresses that are actually in the row can be dragged, and the
  // pinned one is not one of them: it is where it is because it is this
  // person's, not because of the order.
  const draggable = canReorder && rest.length > 1

  /** One address's tab. `index` is its place among the draggable ones, or null
   *  for the pinned address, which sits still. */
  const inboxTab = (inbox: TabInbox, index: number | null) => {
    const movable = draggable && index !== null
    return {
      key: inbox.id,
      href: link(inbox.id),
      active: current === inbox.id,
      label: (
        <span
          className="uin-tab"
          title={index === null ? `${inbox.address} - your own inbox` : inbox.address}
          data-uin-drag={movable ? '1' : undefined}
          data-uin-dragging={movable && dragId === inbox.id ? '1' : undefined}
          data-uin-over={movable && overId === inbox.id && dragId !== inbox.id ? '1' : undefined}
          draggable={movable}
          onDragStart={(event: React.DragEvent<HTMLSpanElement>) => {
            if (!movable) return
            setDragId(inbox.id)
            // Overwritten deliberately: a dragged link otherwise carries its own
            // URL, and dropping it on the address bar or another window would be
            // a surprise nobody asked for.
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', inbox.id)
          }}
          onDragOver={(event: React.DragEvent<HTMLSpanElement>) => {
            if (!movable || !dragId) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            setOverId(inbox.id)
          }}
          onDragLeave={() => setOverId((c) => (c === inbox.id ? null : c))}
          onDrop={(event: React.DragEvent<HTMLSpanElement>) => {
            if (!movable || !dragId) return
            event.preventDefault()
            const from = dragId
            setDragId(null)
            setOverId(null)
            move(from, inbox.id)
          }}
          onDragEnd={() => { setDragId(null); setOverId(null) }}
        >
          <span className="uin-tab-name">{inbox.name}</span>
          <Count value={inbox.count} />
          {index === null && <span className="sr-only"> . Your own inbox.</span>}
          {/* How to move an address without a mouse has to reach the thing that
              takes the keystroke, which is core's link around this span rather
              than the span itself. Said as words inside it: a link takes its name
              from what is in it, so this reaches the keyboard everywhere, where a
              description hung on the span reached nobody and an aria-label on a
              span with no role of its own is not something every browser honours
              either. */}
          {movable && (
            <span className="sr-only">
              . Hold Alt and press the left or right arrow keys to move it along the row.
            </span>
          )}
        </span>
      ),
    }
  }

  const items = [
    // Ahead of All, because it is what this person opened the hub to read.
    ...(pinned ? [inboxTab(pinned, null)] : []),
    {
      key: 'all',
      // Named rather than left out: with an address of their own, an empty
      // inbox param means "take me to mine", so All has to say so out loud.
      href: link('all'),
      active: current === null,
      label: (
        <span className="uin-tab">
          <span className="uin-tab-name">All</span>
          <Count value={allCount} />
        </span>
      ),
    },
    ...rest.map((inbox, index) => inboxTab(inbox, index)),
    ...channels.map((channel) => ({
      key: `m:${channel.moduleName}`,
      href: link(`m:${channel.moduleName}`),
      active: current === `m:${channel.moduleName}`,
      label: (
        <span className="uin-tab">
          <span className="uin-tab-name">{channel.label}</span>
          <Count value={channel.count} />
        </span>
      ),
    })),
    {
      // No count beside it, unlike every other tab in the row: the counts are of
      // conversations nobody has read yet, and nothing you sent yourself is
      // waiting to be read by you.
      key: 'sent',
      href: link('sent'),
      active: current === 'sent',
      label: (
        <span className="uin-tab" title="Everything that has left, from every address you can read">
          <span className="uin-tab-name">Sent</span>
        </span>
      ),
    },
    ...(showDrafts ? [{
      key: 'drafts',
      href: link('drafts'),
      active: current === 'drafts',
      label: (
        <span className="uin-tab" title="Messages you have started and not sent">
          <span className="uin-tab-name">Drafts</span>
          <Count value={draftCount} word="saved" />
        </span>
      ),
    }] : []),
    ...(showUnrouted ? [{
      key: 'none',
      href: link('none'),
      active: current === 'none',
      label: (
        <span className="uin-tab" title="Mail that reached the account but matched none of your addresses">
          <span className="uin-tab-name">Not filed</span>
          <Count value={unroutedCount} />
        </span>
      ),
    }] : []),
  ]

  // Alt and an arrow key does what dragging does, because a rearrangement only a
  // mouse can perform is a rearrangement some people cannot perform at all. The
  // handler sits on the wrapper rather than on a tab: core's strip owns the
  // links, and the keystroke arrives at the focused link and travels upwards.
  const onStripKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!draggable || !event.altKey) return
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    // Held in a local: React empties currentTarget the moment the handler
    // returns, and the focus below happens a frame later.
    const strip = event.currentTarget
    const links = Array.from(strip.querySelectorAll<HTMLAnchorElement>('a[href]'))
    const at = links.indexOf((event.target as HTMLElement).closest('a') as HTMLAnchorElement)
    // What comes before the movable addresses: this person's own one if they
    // have been given one, and then All, which is nobody's address. Anything
    // past them - a channel, Not filed, Drafts - is not ours either.
    const offset = pinned ? 2 : 1
    const index = at - offset
    if (index < 0 || index >= rest.length) return
    const to = event.key === 'ArrowLeft' ? index - 1 : index + 1
    if (to < 0 || to >= rest.length) return
    event.preventDefault()
    move(rest[index]!.id, rest[to]!.id)
    // The keyboard follows the address it just moved, so a second press carries
    // on from where it is rather than from whatever landed under the cursor.
    requestAnimationFrame(() => {
      strip.querySelectorAll<HTMLAnchorElement>('a[href]')[to + offset]?.focus()
    })
  }

  return (
    <div onKeyDown={onStripKeyDown}>
      <div className="uin-tabrow">
        {canCheckNow && <CheckNowButton onResult={setNotice} autoSeconds={autoCheckSeconds} />}
        <div className="uin-tabrow-strip">
          <TabStrip
            style={{ marginBottom: '0.5rem' }}
            items={items}
            trailing={composeHref ? (
              <Link className="uin-compose" href={composeHref} aria-label="Write a message">
                {PenIcon}
                <span className="uin-compose-words">Write a message</span>
              </Link>
            ) : undefined}
          />
        </div>
      </div>
      {notice && (
        <div
          className={`alert ${notice.tone === 'ok' ? 'alert-info' : 'alert-danger'}`}
          role="status"
        >
          {notice.text}
        </div>
      )}
      {error && <div className="alert alert-danger" role="alert">{error}</div>}
    </div>
  )
}
