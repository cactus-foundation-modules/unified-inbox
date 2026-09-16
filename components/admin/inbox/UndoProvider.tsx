'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { UndoToast } from './UndoToast'

/** A point on the screen, in viewport coordinates. Passed with an offer when
 *  the caller already knows where the press was; otherwise the provider
 *  remembers the last pointer down inside the page. */
export type UndoAnchor = { x: number; y: number }

/** Read from a click or pointer event when an offer is raised in the same
 *  handler. Most callers need not bother - see UndoProvider. */
export function undoAt(event: Pick<MouseEvent, 'clientX' | 'clientY'>): UndoAnchor {
  return { x: event.clientX, y: event.clientY }
}

function anchorFromFocus(): UndoAnchor | null {
  const el = document.activeElement
  if (!(el instanceof HTMLElement)) return null
  const box = el.getBoundingClientRect()
  if (box.width === 0 && box.height === 0) return null
  return { x: box.left + box.width / 2, y: box.bottom }
}

// ---------------------------------------------------------------------------
// Where the regret window lives.
//
// The toast itself is five seconds and a button (see UndoToast). What it could
// not do was outlive the thing that raised it, and every press worth undoing on
// this screen ends with that thing leaving: junking a conversation shuts the
// pane the junk button was drawn in, snoozing a pile of six empties the bar the
// press came from. The toast went with them - it was a child of a component
// that had just been unmounted - so the one press people most want back was the
// one press with no way back.
//
// So the offer is raised HERE, above the list and the conversation both, from a
// component that is mounted for as long as the inbox is on the screen. Whoever
// raises it hands over two things and forgets about it: what happened, in the
// past tense, and how to put it back.
//
// Putting it back is a bare request rather than a call into the component that
// offered it. That component is usually gone by the time anybody presses Undo,
// and a closure reaching into its state would be reaching into a screen that no
// longer exists. Redrawing afterwards is this component's job for the same
// reason.
// ---------------------------------------------------------------------------

export type UndoOffer = {
  /** What just happened, in the past tense - "Moved to spam.", "6 snoozed." */
  message: ReactNode
  /** Put it back. Requests only: whatever raised this has very probably been
   *  unmounted by now. The redraw afterwards is handled here. */
  undo: () => Promise<void>
  /** Where to draw the toast. Left out on most calls: the last pointer down, or
   *  the button that still has focus, is enough. */
  at?: UndoAnchor | null
}

const OfferUndo = createContext<(offer: UndoOffer) => void>(() => {})

/** Raise a five-second offer to take the last press back. Safe to call from
 *  anywhere under the provider; a component outside one simply gets a no-op,
 *  which is the right answer for a screen with nowhere to put a toast. */
export function useOfferUndo() {
  return useContext(OfferUndo)
}

export function UndoProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  // The key restarts the five seconds. UndoToast sets its timers once, on
  // mount, so a second press while the first toast is still up would otherwise
  // inherit whatever was left of the first one's countdown.
  const [offer, setOffer] = useState<(UndoOffer & { key: number; at: UndoAnchor | null }) | null>(null)
  const nextKey = useRef(0)
  // Where the last press landed. Most offers fire after an async request, often
  // from a component that has already unmounted, so the toast cannot read the
  // button's box back - but the press itself happened a moment ago.
  const lastPointer = useRef<UndoAnchor | null>(null)

  useEffect(() => {
    const remember = (event: PointerEvent) => {
      lastPointer.current = { x: event.clientX, y: event.clientY }
    }
    document.addEventListener('pointerdown', remember, true)
    return () => document.removeEventListener('pointerdown', remember, true)
  }, [])

  const show = useCallback((next: UndoOffer) => {
    nextKey.current += 1
    const { at: given, ...rest } = next
    setOffer({
      ...rest,
      key: nextKey.current,
      at: given ?? lastPointer.current ?? anchorFromFocus(),
    })
  }, [])

  const undo = useCallback(async (which: UndoOffer) => {
    // Gone from the screen the moment it is pressed - the request is on its
    // way, and a toast still offering to undo something it has already undone
    // is an invitation to press it twice.
    setOffer(null)
    try {
      await which.undo()
    } finally {
      router.refresh()
    }
  }, [router])

  // `show` is built once, so nothing under this provider redraws because a
  // toast came and went.
  return (
    <OfferUndo.Provider value={show}>
      {children}
      {offer && (
        <UndoToast
          key={offer.key}
          at={offer.at}
          onUndo={() => void undo(offer)}
          onDone={() => setOffer((current) => (current?.key === offer.key ? null : current))}
        >
          {offer.message}
        </UndoToast>
      )}
    </OfferUndo.Provider>
  )
}
