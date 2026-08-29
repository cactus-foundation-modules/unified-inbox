'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { moveInOrder } from '@/modules/unified-inbox/lib/list'

// The addresses in the rail, in whatever order somebody has put them in.
//
// Sites end up with an inbox they live in and three they glance at, and
// alphabetical order has no opinion about which is which. So the order is
// dragged rather than configured: the rail is where the question is asked, so
// it is where it is answered, and nobody goes hunting through settings for a
// number field called "sort order".
//
// Everything a reader without `manage` sees is the plain rail it always was -
// same markup, same links, no handles, nothing draggable. The order belongs to
// the site rather than to one person (it is a column on the inbox, not on the
// user), so the people who look after the addresses are the ones who arrange
// them.
//
// Dropping saves straight away and the rail moves first, because the whole
// gesture is over in half a second and a list that snaps back while a request
// finishes reads as a bug. If the save is refused the order goes back to what
// it was and says so, rather than showing an arrangement the site has not kept.

export type RailInboxItem = {
  id: string
  name: string
  address: string
  href: string
  count: number
}

type Props = {
  items: RailInboxItem[]
  currentInboxId: string | null
  canReorder: boolean
}

export function RailInboxes({ items, currentInboxId, canReorder }: Props) {
  const router = useRouter()
  const [order, setOrder] = useState(items)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [error, setError] = useState('')
  // What the server last told us, so a refresh that genuinely changed the list
  // (an inbox added, one deleted, somebody else's rearrangement) replaces what
  // is on screen, while our own optimistic move does not get overwritten by the
  // refresh it triggered.
  const serverKey = items.map((i) => i.id).join('|')
  const lastServerKey = useRef(serverKey)
  useEffect(() => {
    if (lastServerKey.current === serverKey) return
    lastServerKey.current = serverKey
    setOrder(items)
  }, [serverKey, items])

  const save = useCallback(async (next: RailInboxItem[], previous: RailInboxItem[]) => {
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
      lastServerKey.current = next.map((i) => i.id).join('|')
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

  const onKeyDown = (event: React.KeyboardEvent<HTMLAnchorElement>, index: number) => {
    if (!canReorder || !event.altKey) return
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    // Alt is what the arrows need, so an inbox never wanders off while somebody
    // is only reading down the rail with the keyboard.
    event.preventDefault()
    move(index, event.key === 'ArrowUp' ? index - 1 : index + 1)
    // The link keeps the focus so a second press carries on from where it is.
    ;(event.currentTarget as HTMLAnchorElement).focus()
  }

  return (
    <>
      {canReorder && order.length > 1 && (
        <p className="sr-only" id="uin-rail-reorder-hint">
          Drag an address to put the rail in the order you want it, or hold Alt and press the up
          and down arrow keys.
        </p>
      )}
      {order.map((inbox, index) => (
        <a
          key={inbox.id}
          href={inbox.href}
          aria-current={currentInboxId === inbox.id ? 'page' : undefined}
          title={inbox.address}
          aria-describedby={canReorder && order.length > 1 ? 'uin-rail-reorder-hint' : undefined}
          draggable={canReorder && order.length > 1}
          data-uin-drag={canReorder && order.length > 1 ? '1' : undefined}
          data-uin-dragging={dragId === inbox.id ? '1' : undefined}
          data-uin-over={overId === inbox.id && dragId !== inbox.id ? '1' : undefined}
          onKeyDown={(event) => onKeyDown(event, index)}
          onDragStart={(event) => {
            if (!canReorder) return
            setDragId(inbox.id)
            // Overwritten deliberately: a dragged link otherwise carries its own
            // URL, and dropping it on the address bar or another window would be
            // a surprise nobody asked for.
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', inbox.id)
          }}
          onDragOver={(event) => {
            if (!canReorder || !dragId) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            setOverId(inbox.id)
          }}
          onDragLeave={() => setOverId((current) => (current === inbox.id ? null : current))}
          onDrop={(event) => {
            if (!canReorder || !dragId) return
            event.preventDefault()
            const from = order.findIndex((i) => i.id === dragId)
            setDragId(null)
            setOverId(null)
            move(from, index)
          }}
          onDragEnd={() => { setDragId(null); setOverId(null) }}
        >
          <span className="uin-rail-name">{inbox.name}</span>
          {inbox.count > 0 && (
            <span className="uin-rail-count">
              {inbox.count > 99 ? '99+' : inbox.count}
              <span className="sr-only"> unread</span>
            </span>
          )}
        </a>
      ))}
      {error && <div className="alert alert-danger" role="alert">{error}</div>}
    </>
  )
}
