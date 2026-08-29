'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { TabStrip } from '@/components/admin/TabStrip'
import { inboxHref, moveInOrder } from '@/modules/unified-inbox/lib/list'
import { PenIcon } from './icons'

// What the list is a list of, along the top: everything at once, then each
// address people write to, then the channels another module owns, then Sent and
// Drafts where a mail program has kept them for thirty years, and last of all
// mail nobody could file - which only an administrator sees at all.
//
// It is core's tab strip rather than a rail of this module's own, so the inbox
// arrives looking like every other admin screen with tabs and scrolls its own
// overflow on a narrow window instead of eating a column of the reading area.
// Unread counts ride in the labels, because "is there anything new in
// accounts@" is the question this row is answering.
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
  /** Whether this person may drag the addresses into a different order. The
   *  order is the site's rather than one person's, so it takes `manage`. */
  canReorder: boolean
}

function Count({ value, word = 'unread' }: { value: number; word?: string }) {
  if (!value) return null
  return (
    <span className="uin-tab-count">
      {value > 99 ? '99+' : value}
      <span className="sr-only"> {word}</span>
    </span>
  )
}

export function InboxTabs({
  base, params, inboxes, channels, allCount, current, showUnrouted, unroutedCount,
  showDrafts, draftCount, composeHref, canReorder,
}: Props) {
  const router = useRouter()
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

  const move = useCallback((from: number, to: number) => {
    const next = moveInOrder(order, from, to)
    if (next === order) return
    setOrder(next)
    void save(next, order)
  }, [order, save])

  // Changing tab always goes back to page one and drops whichever conversation
  // was open - it belongs to the tab being left.
  const link = (inbox: string | null) =>
    inboxHref(base, params, { inbox, page: null, id: null, person: null, compose: null, draft: null })

  const draggable = canReorder && order.length > 1

  const items = [
    {
      key: 'all',
      href: link(null),
      active: current === null,
      label: (
        <span className="uin-tab">
          <span className="uin-tab-name">All</span>
          <Count value={allCount} />
        </span>
      ),
    },
    ...order.map((inbox, index) => ({
      key: inbox.id,
      href: link(inbox.id),
      active: current === inbox.id,
      label: (
        <span
          className="uin-tab"
          title={inbox.address}
          data-uin-drag={draggable ? '1' : undefined}
          data-uin-dragging={dragId === inbox.id ? '1' : undefined}
          data-uin-over={overId === inbox.id && dragId !== inbox.id ? '1' : undefined}
          aria-describedby={draggable ? 'uin-tabs-reorder-hint' : undefined}
          draggable={draggable}
          onDragStart={(event: React.DragEvent<HTMLSpanElement>) => {
            if (!draggable) return
            setDragId(inbox.id)
            // Overwritten deliberately: a dragged link otherwise carries its own
            // URL, and dropping it on the address bar or another window would be
            // a surprise nobody asked for.
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', inbox.id)
          }}
          onDragOver={(event: React.DragEvent<HTMLSpanElement>) => {
            if (!draggable || !dragId) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            setOverId(inbox.id)
          }}
          onDragLeave={() => setOverId((c) => (c === inbox.id ? null : c))}
          onDrop={(event: React.DragEvent<HTMLSpanElement>) => {
            if (!draggable || !dragId) return
            event.preventDefault()
            const from = order.findIndex((i) => i.id === dragId)
            setDragId(null)
            setOverId(null)
            move(from, index)
          }}
          onDragEnd={() => { setDragId(null); setOverId(null) }}
        >
          <span className="uin-tab-name">{inbox.name}</span>
          <Count value={inbox.count} />
        </span>
      ),
    })),
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
    // The All tab is first and is nobody's address, so the addresses start one
    // along. Anything past them - a channel, Not filed, Drafts - is not ours.
    const index = at - 1
    if (index < 0 || index >= order.length) return
    const to = event.key === 'ArrowLeft' ? index - 1 : index + 1
    if (to < 0 || to >= order.length) return
    event.preventDefault()
    move(index, to)
    // The keyboard follows the address it just moved, so a second press carries
    // on from where it is rather than from whatever landed under the cursor.
    requestAnimationFrame(() => {
      strip.querySelectorAll<HTMLAnchorElement>('a[href]')[to + 1]?.focus()
    })
  }

  return (
    <div onKeyDown={onStripKeyDown}>
      {draggable && (
        <p className="sr-only" id="uin-tabs-reorder-hint">
          Drag an address along the row to put it in the order you want it, or hold Alt and press
          the left and right arrow keys.
        </p>
      )}
      <TabStrip
        style={{ marginBottom: '0.5rem' }}
        items={items}
        trailing={composeHref ? (
          <a className="uin-compose" href={composeHref} aria-label="Write a message">
            {PenIcon}
            <span className="uin-compose-words">Write a message</span>
          </a>
        ) : undefined}
      />
      {error && <div className="alert alert-danger" role="alert">{error}</div>}
    </div>
  )
}
