'use client'

import { useEffect, useRef, useState } from 'react'
import { openLineAfter, touchingBlockPairs } from '@/modules/unified-inbox/lib/richtext-blocks'

/**
 * A new line between two products that are touching.
 *
 * Two blocks with nothing between them leave nowhere to put a caret - each is
 * one object, and the hair of space between them belongs to neither - so
 * "this one is the cheapest" has nowhere to go between the chair and the desk.
 * This finds that seam under the pointer and offers a line there.
 *
 * A mouse: hovering the seam draws it, with "Click to add new line", and a
 * click opens the line. A finger has no hover, so the first tap on the seam is
 * the hover - "Tap again to add new line" - and a second tap on the same seam
 * within a few seconds opens it. Anything else (a tap elsewhere, typing,
 * scrolling) puts the offer away.
 *
 * Native listeners rather than React's: the finger's tap has to be refused
 * outright on touchend, before the browser turns it into a click that drops the
 * caret somewhere and opens the keyboard, and React's touch listeners are
 * passive, so a refusal there is ignored.
 */

/** Where to draw the seam, relative to the box's wrapper. */
export type Seam = { top: number; left: number; width: number; touch: boolean }

/** How far either side of the gap still counts as "on the seam", in pixels.
 *  The gap itself is 6px; a finger is not. */
const MOUSE_REACH = 6
const FINGER_REACH = 12
/** How long a first tap stays armed for the second. */
const ARMED_FOR = 5000
/** A finger that moved further than this was scrolling, not tapping. */
const TAP_SLOP = 10

type Hit = { first: Element; seam: Omit<Seam, 'touch'> }

function seamAt(box: HTMLElement, x: number, y: number, reach: number): Hit | null {
  const frame = box.parentElement
  if (!frame) return null
  const home = frame.getBoundingClientRect()
  for (const [first, second] of touchingBlockPairs(box)) {
    const a = first.getBoundingClientRect()
    const b = second.getBoundingClientRect()
    // One under the other, which is the only way they are drawn - anything
    // else is not a seam a line can go in.
    if (b.top < a.bottom - 1) continue
    const left = Math.min(a.left, b.left)
    const right = Math.max(a.right, b.right)
    if (x < left || x > right) continue
    if (y < a.bottom - reach || y > b.top + reach) continue
    return {
      first,
      seam: { top: (a.bottom + b.top) / 2 - home.top, left: left - home.left, width: right - left },
    }
  }
  return null
}

export function useBlockSeams(box: HTMLElement | null, onLine: () => void): Seam | null {
  const [seam, setSeam] = useState<Seam | null>(null)
  // Kept current without re-binding every listener on every render.
  const lineRef = useRef(onLine)
  useEffect(() => { lineRef.current = onLine }, [onLine])

  useEffect(() => {
    if (!box) return
    /** The block above the seam on show, and whether a finger armed it. */
    let shown: { first: Element; touch: boolean; at: number } | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let touchStart: { x: number; y: number } | null = null

    const hide = () => {
      shown = null
      if (timer) { clearTimeout(timer); timer = null }
      box.classList.remove('uin-rt-seam-hot')
      setSeam(null)
    }
    const show = (hit: Hit, touch: boolean) => {
      if (shown?.first === hit.first && shown.touch === touch) return
      shown = { first: hit.first, touch, at: Date.now() }
      if (!touch) box.classList.add('uin-rt-seam-hot')
      setSeam({ ...hit.seam, touch })
    }
    const open = (first: Element) => {
      hide()
      if (openLineAfter(box, first)) lineRef.current()
    }

    const onMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      const hit = seamAt(box, event.clientX, event.clientY, MOUSE_REACH)
      if (hit) show(hit, false)
      else if (shown && !shown.touch) hide()
    }
    const onLeave = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' && shown && !shown.touch) hide()
    }
    const onDown = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || event.button !== 0) return
      const hit = seamAt(box, event.clientX, event.clientY, MOUSE_REACH)
      if (!hit) return
      // Refused, so the press neither moves the caret nor starts a selection.
      event.preventDefault()
      open(hit.first)
    }

    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0]
      touchStart = touch && event.touches.length === 1
        ? { x: touch.clientX, y: touch.clientY }
        : null
    }
    const onTouchEnd = (event: TouchEvent) => {
      const start = touchStart
      touchStart = null
      const touch = event.changedTouches[0]
      if (!start || !touch) return
      if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > TAP_SLOP) return
      const hit = seamAt(box, touch.clientX, touch.clientY, FINGER_REACH)
      if (!hit) { if (shown) hide(); return }
      // No click, no caret, no keyboard for the first tap - it only asks.
      event.preventDefault()
      if (shown?.touch && shown.first === hit.first && Date.now() - shown.at < ARMED_FOR) {
        open(hit.first)
        return
      }
      show(hit, true)
      if (timer) clearTimeout(timer)
      timer = setTimeout(hide, ARMED_FOR)
    }

    box.addEventListener('pointermove', onMove)
    box.addEventListener('pointerleave', onLeave)
    box.addEventListener('pointerdown', onDown)
    box.addEventListener('touchstart', onTouchStart, { passive: true })
    box.addEventListener('touchend', onTouchEnd, { passive: false })
    // A seam measured before the words moved is in the wrong place.
    box.addEventListener('scroll', hide)
    box.addEventListener('input', hide)
    return () => {
      box.removeEventListener('pointermove', onMove)
      box.removeEventListener('pointerleave', onLeave)
      box.removeEventListener('pointerdown', onDown)
      box.removeEventListener('touchstart', onTouchStart)
      box.removeEventListener('touchend', onTouchEnd)
      box.removeEventListener('scroll', hide)
      box.removeEventListener('input', hide)
      if (timer) clearTimeout(timer)
      box.classList.remove('uin-rt-seam-hot')
    }
  }, [box])

  return seam
}
