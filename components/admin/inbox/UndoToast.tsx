'use client'

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { UndoAnchor } from './UndoProvider'

// The small regret window. Marking a conversation done takes it off the list
// you are looking at, and the only way back was to know that "All" exists and
// which of the forty rows in it was yours - so the thing that took it away now
// offers to put it back, for five seconds, beside the button that did it.
//
// It says what happened rather than asking a question: a dialog to confirm
// something this cheap to reverse would be four presses to do one thing.

/** How long it stands there before it starts going, and how long the going
 *  takes. The fade is a transition on a class, so a reader who has asked for
 *  less movement gets the same five seconds and then nothing. */
const HOLD_MS = 5000
const FADE_MS = 300
const PAD = 12
const GAP = 8

type Props = {
  /** What just happened, in the past tense. */
  children: ReactNode
  /** Where the press was. Null falls back to the foot of the screen. */
  at: UndoAnchor | null
  /** Put it back. Shutting the toast is this component's job, not the
   *  caller's - it is gone the moment the button is pressed. */
  onUndo: () => void
  /** Said when the five seconds are up, or the undo has been taken. The caller
   *  drops the toast on this. */
  onDone: () => void
}

/** Sit the toast beside the press without letting it fall off the window. */
function placeToast(box: DOMRect, at: UndoAnchor): { top: number; left: number } {
  let left = at.x - box.width / 2
  let top = at.y + GAP
  if (top + box.height > window.innerHeight - PAD) top = at.y - GAP - box.height
  left = Math.max(PAD, Math.min(left, window.innerWidth - box.width - PAD))
  top = Math.max(PAD, Math.min(top, window.innerHeight - box.height - PAD))
  return { top, left }
}

export function UndoToast({ children, at, onUndo, onDone }: Props) {
  const [going, setGoing] = useState(false)
  const card = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  // Held in a ref so the timers below are set once and are not restarted by a
  // parent that re-renders - which, on a screen that refreshes itself after
  // every change, it does. Kept up to date in its own effect rather than in the
  // render: a ref written while rendering is a ref written twice under Strict
  // Mode, and the lint rule that says so is right.
  const done = useRef(onDone)
  useEffect(() => { done.current = onDone }, [onDone])

  useEffect(() => {
    const fade = window.setTimeout(() => setGoing(true), HOLD_MS)
    const gone = window.setTimeout(() => done.current(), HOLD_MS + FADE_MS)
    return () => {
      window.clearTimeout(fade)
      window.clearTimeout(gone)
    }
  }, [])

  useLayoutEffect(() => {
    const el = card.current
    if (!el || !at) {
      setPos(null)
      return
    }
    setPos(placeToast(el.getBoundingClientRect(), at))
  }, [at, children])

  // Into the page itself, never where it was written. The toast is raised by a
  // button on the conversation's pinned header, which is a sticky element with
  // a stacking context of its own inside a pane that scrolls and clips its own
  // contents - so a toast left there is fixed to the window but painted inside
  // that pane, and the half of it that reaches across the middle of the screen
  // goes behind the list column, Undo and all. Every other floating thing on
  // this screen - the dialogs, the composer, the product picker - escapes the
  // same way. There is no page on the server, and this is never rendered on a
  // first paint, so the two sides agree.
  if (typeof document === 'undefined') return null

  return createPortal(
    // Polite rather than assertive: it is a receipt, and it must not talk over
    // whatever the reader is already being read.
    <div
      ref={card}
      className="uin-toast"
      data-going={going ? '1' : undefined}
      data-anchored={at ? '1' : undefined}
      style={at && pos ? { top: pos.top, left: pos.left } : undefined}
      role="status"
      aria-live="polite"
    >
      <span className="uin-toast-text">{children}</span>
      <button
        type="button"
        className="uin-toast-undo"
        onClick={() => {
          onUndo()
          done.current()
        }}
      >
        Undo
      </button>
    </div>,
    document.body,
  )
}
