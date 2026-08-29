'use client'

import { useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

// The one place in the inbox that asks "are you sure".
//
// It exists because five things in here used to ask with window.confirm, which
// is a browser box in a browser typeface with the site's name at the top of it,
// cannot be styled, cannot be read by anybody using the site in another
// language, and freezes the tab while it waits. This is the same question in the
// screen's own clothes, on the module's own modal, and it behaves the way a
// dialog is supposed to: the keyboard cannot walk out of it, Escape says no, and
// when it closes the keyboard goes back to the button that opened it.
//
// PROPS
//   open          Whether it is on the screen. Render the component the whole
//                 time and flip this - it returns null while it is false.
//   title         The question, in a few words. Sentence case, ends in a
//                 question mark: "Throw this draft away?"
//   body          What happens if the answer is yes, spelled out. Text, or any
//                 markup you like.
//   confirmLabel  What the yes button says. Default "Yes, go ahead", but say
//                 what will actually happen wherever you can: "Throw it away",
//                 "Merge them", "Erase them". Never "OK".
//   cancelLabel   Default "Cancel".
//   destructive   Something is lost if they say yes. Paints the yes button as
//                 destructive and starts the keyboard on Cancel, so a stray
//                 Return does the safe thing.
//   busy          Greys both answers out while the work is in flight. The
//                 dialog stays open; close it when the work has finished.
//                 What happens to the keyboard while it is true: the browser
//                 takes focus off a button the moment that button is disabled,
//                 so the dialog catches it and parks it on the card itself. The
//                 trap and Escape both go on working - Escape is listened for on
//                 the page rather than on the dialog for exactly this reason -
//                 and when busy goes false again the keyboard is put back on the
//                 answer it started on. Nothing for the caller to do; it is
//                 written down because it is not obvious.
//   onConfirm     They said yes. Closing is the caller's job - set open to
//                 false, either straight away or once the work is done.
//   onCancel      They said no. Cancel, Escape, and a click on the background
//                 all land here. It is called while busy is true as well, since
//                 Escape still works: if a cancelled request would leave things
//                 half done, ignore it while your own request is in flight.
//
// HOW TO USE IT
//   const [asking, setAsking] = useState(false)
//   ...
//   <button type="button" className="btn btn-secondary btn-sm"
//           onClick={() => setAsking(true)}>Throw the draft away</button>
//   <ConfirmDialog
//     open={asking}
//     title="Throw this draft away?"
//     body="What you have written goes with it, and there is no getting it back."
//     confirmLabel="Throw it away"
//     destructive
//     busy={busy}
//     onCancel={() => setAsking(false)}
//     onConfirm={() => { setAsking(false); void discard() }}
//   />
//
// It renders into the end of the page rather than where it is written, so it is
// safe to put one inside a pane that scrolls its own contents.

export type ConfirmDialogProps = {
  open: boolean
  title: string
  body: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** Everything the keyboard can land on. Used to work out where the ends of the
 *  dialog are, so Tab can be sent round in a circle rather than out of it. The
 *  card itself is in the list as well, because while the work is in flight both
 *  buttons are disabled and it is the only thing left to stand on. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Yes, go ahead',
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cardRef = useRef<HTMLDivElement | null>(null)
  const returnTo = useRef<HTMLElement | null>(null)
  // The listener below is put on the page once and left there for as long as the
  // dialog is open, so it reads the latest onCancel out of here rather than
  // being torn down and rebuilt every time the caller renders a new closure.
  const cancelRef = useRef(onCancel)
  const id = useId()
  const titleId = `${id}-title`
  const bodyId = `${id}-body`

  useEffect(() => { cancelRef.current = onCancel })

  /** The answer the keyboard should be on: the safe one when something is about
   *  to be lost, so a stray Return does the harmless thing. */
  const startSelector = destructive ? '[data-uin-cancel]' : '[data-uin-confirm]'

  useEffect(() => {
    if (!open) return
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cardRef.current?.querySelector<HTMLElement>(startSelector)?.focus()
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
      returnTo.current?.focus()
    }
  }, [open, startSelector])

  // Disabling a button the keyboard is standing on drops the keyboard back on
  // the page, which would leave the dialog trapping nothing and hearing nothing.
  // So: whenever busy turns over, put the keyboard somewhere sensible inside the
  // card - the card itself while the answers are greyed out, and the answer it
  // started on once they come back.
  useEffect(() => {
    if (!open) return
    const card = cardRef.current
    if (!card) return
    const active = document.activeElement
    if (!card.contains(active)) {
      card.focus()
    } else if (active === card && !busy) {
      card.querySelector<HTMLElement>(startSelector)?.focus()
    }
  }, [open, busy, startSelector])

  // On the page rather than on the dialog. A key pressed while both answers are
  // disabled does not start inside the dialog at all, and a handler hung on the
  // dialog would never hear it.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Stopped here so a dialog opened over the compose window does not shut
        // the compose window as well.
        event.preventDefault()
        event.stopPropagation()
        cancelRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const card = cardRef.current
      if (!card) return
      const items = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE))
      // The card is the far end of the ring, and while the answers are greyed
      // out it is the whole of it.
      const ring = [card, ...items]
      const first = ring[0]
      const last = ring[ring.length - 1]
      if (!first || !last) return
      const active = document.activeElement
      if (!card.contains(active)) {
        event.preventDefault()
        first.focus()
        return
      }
      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open])

  // The dialog goes into the page itself, and there is no page on the server.
  // Nothing here is ever open on a first render, so the two sides agree.
  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      className="uin-modal"
      // Only the background itself, not something inside the card that happened
      // to finish its drag out here.
      onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}
    >
      <div
        ref={cardRef}
        className="uin-modal-card uin-modal-card-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        // Somewhere for the keyboard to stand when both answers are greyed out.
        // Never in the Tab order of the page itself, only of the ring above.
        tabIndex={-1}
      >
        <div className="uin-modal-head">
          <h2 className="uin-modal-title" id={titleId}>{title}</h2>
        </div>
        <div className="uin-modal-body">
          <div className="uin-confirm-body" id={bodyId}>{body}</div>
        </div>
        <div className="uin-modal-foot">
          <button
            type="button"
            className="btn btn-secondary"
            data-uin-cancel=""
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${destructive ? 'btn-destructive' : 'btn-primary'}`}
            data-uin-confirm=""
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
