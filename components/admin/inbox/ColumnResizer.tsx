'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_WIDTHS,
  WIDTH_LIMITS,
  parseStoredWidths,
  roomForColumns,
  settleWidths,
  type ColumnEdge,
  type ColumnWidths,
} from './column-widths'

// The two hairlines between the rail, the list and the conversation, made
// draggable.
//
// Every mail program lets somebody set these, and for the same reason: how wide
// the list wants to be is a question about the person reading it, not about the
// screen. Somebody triaging a hundred a day wants a wide list and a narrow rail;
// somebody reading long threads wants the opposite, and one shipped middle is
// wrong for both of them.
//
// It writes two custom properties onto the document and does nothing else to the
// page. The stylesheet's grid reads them through fallbacks - var(--uin-w-rail,
// 15rem), var(--uin-w-list, 24rem) - so with nothing stored the layout is
// exactly what this module shipped with, which is also why the frame can go on
// being server-rendered without knowing any of this exists.
//
// ON THE DOCUMENT RATHER THAN ON THE FRAME, because the campaigns screen is a
// second frame with the same rail down its left. Set on the frame, a rail
// dragged narrower in the inbox would spring back to fifteen rems the moment
// somebody opened Campaigns and back again on the way out. Campaigns mounts this
// with `handles={false}`: it reads and applies the width, and draws nothing,
// since the only edge it has is the rail's and a full-height grab bar down a
// long form is not worth having.
//
// ONLY FROM 1200px UP, and that is the stylesheet's decision rather than this
// one: below it the rail lies across the top of the frame instead of standing
// beside it, so a full-height handle at the list's edge would sit over the
// rail's own links and eat the clicks. There are two columns there, not three.

const STORAGE_KEY = 'uin-column-widths'

const EDGES: Array<{ edge: ColumnEdge; label: string }> = [
  { edge: 'rail', label: 'Resize the list of places' },
  { edge: 'list', label: 'Resize the list of conversations' },
]

export function ColumnResizer({ handles = true }: { handles?: boolean }) {
  const [widths, setWidths] = useState<ColumnWidths>({ ...DEFAULT_WIDTHS })
  const [dragging, setDragging] = useState<ColumnEdge | null>(null)
  // Where the drag started, so the edge follows the pointer's total travel
  // rather than accumulating a rounding error on every move. The room the two
  // columns have to share is measured once at the start with it: the frame does
  // not change width while somebody is dragging inside it, and measuring on
  // every pointermove is a forced layout per frame for an answer that cannot
  // have moved.
  const originRef = useRef<{ x: number; width: number; room: number } | null>(null)

  // Read the stored preference AFTER mount, never during render. The frame is
  // server-rendered, and a first client render that disagrees with it is a
  // hydration error rather than a narrower rail.
  useEffect(() => {
    let stored: Partial<ColumnWidths> = {}
    try {
      stored = parseStoredWidths(localStorage.getItem(STORAGE_KEY))
    } catch {
      // A browser with storage blocked still gets a working inbox.
    }
    if (stored.rail === undefined && stored.list === undefined) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- must read localStorage after mount or the client's first render diverges from the server's HTML
    setWidths((w) => ({ ...w, ...stored }))
  }, [])

  // The only thing this component does to the page.
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--uin-w-rail', `${widths.rail}px`)
    root.style.setProperty('--uin-w-list', `${widths.list}px`)
  }, [widths])

  const persist = useCallback((next: ColumnWidths) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // Same again: a preference that cannot be saved is still worth having for
      // as long as the tab is open.
    }
  }, [])

  /** How much the two left-hand columns may share right now, which depends on how
   *  wide the frame is and on whether the context panel is standing as a fourth
   *  column at this width. Looked up per drag rather than held: the frame is
   *  server-rendered and replaced wholesale every time somebody opens a row. */
  const room = useCallback((): number | null => {
    const app = document.querySelector('.uin-app') as HTMLElement | null
    if (!app) return null
    const ctxColumn = app.dataset.context === 'on' && window.matchMedia('(min-width: 1500px)').matches
    return roomForColumns(app.clientWidth, ctxColumn)
  }, [])

  const onPointerDown = useCallback((edge: ColumnEdge) => (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    const available = room()
    if (available === null) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    originRef.current = { x: e.clientX, width: widths[edge], room: available }
    setDragging(edge)
  }, [room, widths])

  const onPointerMove = useCallback((edge: ColumnEdge) => (e: React.PointerEvent<HTMLButtonElement>) => {
    const origin = originRef.current
    if (!origin || dragging !== edge) return
    setWidths((current) => settleWidths(origin.room, current, edge, origin.width + (e.clientX - origin.x)))
  }, [dragging])

  const endDrag = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragging) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    originRef.current = null
    setDragging(null)
    persist(widths)
  }, [dragging, persist, widths])

  /** The same drag from the keyboard, because a preference only a mouse can set
   *  is one half the people using this cannot have. Home puts the edge back. */
  const onKeyDown = useCallback((edge: ColumnEdge) => (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const available = room()
    if (available === null) return
    const step = e.shiftKey ? 48 : 16
    let target: number | null = null
    if (e.key === 'ArrowLeft') target = widths[edge] - step
    else if (e.key === 'ArrowRight') target = widths[edge] + step
    else if (e.key === 'Home') target = DEFAULT_WIDTHS[edge]
    if (target === null) return
    e.preventDefault()
    const next = settleWidths(available, widths, edge, target)
    setWidths(next)
    persist(next)
  }, [persist, room, widths])

  const reset = useCallback((edge: ColumnEdge) => () => {
    const available = room()
    if (available === null) return
    const next = settleWidths(available, widths, edge, DEFAULT_WIDTHS[edge])
    setWidths(next)
    persist(next)
  }, [persist, room, widths])

  if (!handles) return null

  return (
    <>
      {EDGES.map(({ edge, label }) => (
        <button
          key={edge}
          type="button"
          className="uin-resize"
          data-edge={edge}
          data-dragging={dragging === edge ? 'on' : undefined}
          role="separator"
          aria-orientation="vertical"
          aria-label={label}
          aria-valuenow={widths[edge]}
          aria-valuemin={WIDTH_LIMITS[edge].min}
          aria-valuemax={WIDTH_LIMITS[edge].max}
          title={`${label} - drag it, or double-click to put it back`}
          onPointerDown={onPointerDown(edge)}
          onPointerMove={onPointerMove(edge)}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={reset(edge)}
          onKeyDown={onKeyDown(edge)}
        >
          <span className="uin-resize-line" aria-hidden="true" />
        </button>
      ))}
    </>
  )
}
