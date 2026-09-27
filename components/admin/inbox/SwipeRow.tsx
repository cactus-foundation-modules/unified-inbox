'use client'

import { useCallback, useEffect, useRef } from 'react'
import { COMMIT_PX, DECIDE_PX, EDGE_PX, isPhone } from './swipe'

// One row of the list, which on a phone slides sideways to show what can be
// done to it - the gesture every mail program on a phone has taught its
// readers. Swipe it left and the buttons on the right come out (Done, Snooze);
// swipe it right and the ones on the left do (Junk, Delete). Let go short of
// halfway and it slides back shut.
//
// The row itself is the child, untouched: it is still a link, still opens the
// conversation on a tap, and still wears every class the list already styles.
// This only moves it. While a finger is on it the move is written straight onto
// the element, because a React render per pixel of a swipe is forty rows
// redrawn sixty times a second; once the finger lifts, which side is open is
// handed up and the stylesheet draws it from the item's own attribute.
//
// Above phone width none of this happens: the trays are not drawn (see
// inbox.css) and the touch handlers stand aside, because a mouse does not swipe
// and a wide screen has the bar above the list for all of this already.

export type SwipeSide = 'start' | 'end'

type Props = {
  className: string
  selected: boolean
  /** Which side is showing its buttons, or null when shut. */
  open: SwipeSide | null
  onOpen: (side: SwipeSide | null) => void
  /** The buttons swiping RIGHT uncovers, on the left-hand side. */
  start: React.ReactNode[]
  /** The buttons swiping LEFT uncovers, on the right-hand side. */
  end: React.ReactNode[]
  children: React.ReactNode
}

/** How wide one button in a tray is, in px. The stylesheet draws them at this
 *  width too (--uin-swipe-btn), so the row stops exactly where they end. */
const BUTTON_PX = 76

export function SwipeRow({ className, selected, open, onOpen, start, end, children }: Props) {
  const item = useRef<HTMLLIElement>(null)
  // Whether the last touch was a swipe, so the click the browser may send after
  // it is not also taken as a tap on the row.
  const swiped = useRef(false)
  const startWidth = start.length * BUTTON_PX
  const endWidth = end.length * BUTTON_PX

  // Kept in a ref so the native listeners below, attached once, read the
  // current values rather than the ones from the render that attached them.
  const live = useRef({ open, onOpen, startWidth, endWidth })
  useEffect(() => {
    live.current = { open, onOpen, startWidth, endWidth }
  }, [open, onOpen, startWidth, endWidth])

  // Native listeners rather than React's: a sideways swipe has to be able to
  // stop the page scrolling, and React attaches touchmove as passive, which
  // cannot.
  useEffect(() => {
    const li = item.current
    if (!li) return
    let x0 = 0
    let y0 = 0
    let from = 0
    let at = 0
    let mode: 'idle' | 'deciding' | 'sliding' = 'idle'
    const face = () => li.querySelector<HTMLElement>(':scope > .uin-row')

    const onStart = (event: TouchEvent) => {
      mode = 'idle'
      if (!isPhone() || event.touches.length !== 1) return
      const touch = event.touches[0]!
      // From the very edge belongs to the list of mailboxes, not to the row.
      if (touch.clientX < EDGE_PX) return
      const { open: side, startWidth: s, endWidth: e } = live.current
      x0 = touch.clientX
      y0 = touch.clientY
      from = side === 'start' ? s : side === 'end' ? -e : 0
      at = from
      mode = 'deciding'
    }

    const onMove = (event: TouchEvent) => {
      if (mode === 'idle') return
      const touch = event.touches[0]
      if (!touch) return
      const dx = touch.clientX - x0
      const dy = touch.clientY - y0
      if (mode === 'deciding') {
        if (Math.abs(dx) < DECIDE_PX && Math.abs(dy) < DECIDE_PX) return
        // Mostly up or down is a scroll, and the row leaves it alone.
        if (Math.abs(dy) >= Math.abs(dx)) { mode = 'idle'; return }
        mode = 'sliding'
        li.dataset.dragging = 'true'
      }
      event.preventDefault()
      const { startWidth: s, endWidth: e } = live.current
      // No further than the tray on each side, and not at all towards a side
      // with nothing in it.
      at = Math.max(-e, Math.min(s, from + dx))
      const row = face()
      if (row) row.style.transform = `translateX(${at}px)`
    }

    const onEnd = () => {
      if (mode !== 'sliding') { mode = 'idle'; return }
      mode = 'idle'
      swiped.current = true
      window.setTimeout(() => { swiped.current = false }, 400)
      delete li.dataset.dragging
      const row = face()
      if (row) row.style.transform = ''
      const moved = at - from
      const { open: side, onOpen: set } = live.current
      // Where it lands: past the line in the direction it was pushed opens that
      // side, and anything short of it - or a push back the other way - shuts.
      let next: SwipeSide | null
      if (at >= COMMIT_PX && moved > 0) next = 'start'
      else if (at <= -COMMIT_PX && moved < 0) next = 'end'
      else if (Math.abs(moved) < COMMIT_PX) next = at === 0 ? null : side
      else next = null
      set(next)
    }

    li.addEventListener('touchstart', onStart, { passive: true })
    li.addEventListener('touchmove', onMove, { passive: false })
    li.addEventListener('touchend', onEnd)
    li.addEventListener('touchcancel', onEnd)
    return () => {
      li.removeEventListener('touchstart', onStart)
      li.removeEventListener('touchmove', onMove)
      li.removeEventListener('touchend', onEnd)
      li.removeEventListener('touchcancel', onEnd)
    }
  }, [])

  // A tap on a row that is slid open shuts it rather than opening the
  // conversation, which is what a thumb landing back on it means. Taps on the
  // buttons in the trays go through untouched.
  const onClickCapture = useCallback((event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest('.uin-swipe-tray')) return
    if (swiped.current || live.current.open) {
      event.preventDefault()
      event.stopPropagation()
      if (!swiped.current) live.current.onOpen(null)
    }
  }, [])

  // A tray that is shut is under the row, and `inert` keeps it out of the tab
  // order and away from a screen reader until it is uncovered - a button nobody
  // can see is not one the keyboard should land on.
  return (
    <li
      ref={item}
      className={className}
      data-selected={selected ? 'true' : undefined}
      data-swiped={open ?? undefined}
      style={{
        '--uin-swipe-start': `${startWidth}px`,
        '--uin-swipe-end': `${endWidth}px`,
      } as React.CSSProperties}
      onClickCapture={onClickCapture}
    >
      {start.length > 0 && (
        <div className="uin-swipe-tray" data-side="start" inert={open !== 'start'}>
          {start}
        </div>
      )}
      {end.length > 0 && (
        <div className="uin-swipe-tray" data-side="end" inert={open !== 'end'}>
          {end}
        </div>
      )}
      {children}
    </li>
  )
}
