'use client'

import {
  useCallback, useEffect, useRef, useState,
  type MouseEvent as ReactMouseEvent, type ReactNode,
} from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ConfirmDialog } from './ConfirmDialog'
import { CloseIcon } from './icons'

// The dialog the three short composers live in - a discussion, a text, a call.
//
// ComposeView (a whole email, with attachments, drafts and a schedule) keeps its
// own chrome: it is a screenful with half a dozen ways out of it, and folding
// that into a shared shell would mean a shell with an option for each. These
// three are one short form apiece and were otherwise about to carry three
// copies of the same focus trap, the same Escape handler and the same "you have
// typed something" question - three copies of which two would be fixed.
//
// The bargains are the same ones ComposeView makes, for the same reasons: the
// backdrop is deaf, because a stray click that loses what somebody typed is a
// worse trade than one more press of Cancel; Escape asks first whenever there
// is anything to lose; and the keyboard goes round in a circle inside the card
// rather than off into the inbox behind it.

/** Everything the keyboard can land on inside the card, for the Tab circle. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** A click that was always going to open somewhere else - a new tab, a new
 *  window. Nothing is lost by letting one through. */
function opensElsewhere(event: ReactMouseEvent<HTMLAnchorElement>): boolean {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
}

type Props = {
  title: string
  /** Where the cross and Cancel go: the inbox, with the compose flag dropped. */
  closeHref: string
  /** Whether there is anything typed that closing would lose. */
  guard: boolean
  /** What the question calls the thing being abandoned: "message", "text". */
  noun: string
  /** The id of the field the keyboard should start in. */
  focusId: string
  /** Given the one thing a form inside needs from the shell: the way out that
   *  asks first. Passed rather than exported, because the question it raises is
   *  the shell's own state. */
  children: (api: { askToLeave: () => void }) => ReactNode
}

export function ComposeModal({ title, closeHref, guard, noun, focusId, children }: Props) {
  const router = useRouter()
  const card = useRef<HTMLDivElement>(null)
  const [asking, setAsking] = useState(false)

  const leave = useCallback(() => { router.push(closeHref) }, [closeHref, router])

  const askToLeave = useCallback(() => {
    if (guard) setAsking(true)
    else leave()
  }, [guard, leave])

  // Read out of a box so the listener below is put on the page once and left
  // there, rather than torn down and rebuilt on every keystroke.
  const leaveRef = useRef(askToLeave)
  useEffect(() => { leaveRef.current = askToLeave })

  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    card.current?.querySelector<HTMLElement>(`#${focusId}`)?.focus()
    return () => { document.body.style.overflow = previous }
  }, [focusId])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Whatever is on top of this owns the keyboard.
      if (asking) return
      if (event.key === 'Escape') {
        event.preventDefault()
        leaveRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const inside = card.current
      if (!inside) return
      const items = Array.from(inside.querySelectorAll<HTMLElement>(FOCUSABLE))
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return
      const active = document.activeElement
      if (!inside.contains(active)) {
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
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [asking])

  // Closing the tab is the one loss nothing in here can undo. Only asked when
  // there is something to lose: a guard that fires on an empty box is a guard
  // people learn to click straight through.
  useEffect(() => {
    if (!guard) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [guard])

  const titleId = `uin-modal-title-${focusId}`

  return (
    <div className="uin-modal">
      <div
        className="uin-modal-card uin-modal-card-short"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={card}
      >
        <div className="uin-modal-head">
          <h2 className="uin-modal-title" id={titleId}>{title}</h2>
          <Link
            className="uin-modal-close"
            href={closeHref}
            aria-label="Close without sending"
            onClick={(event) => {
              if (!guard || opensElsewhere(event)) return
              event.preventDefault()
              setAsking(true)
            }}
          >
            {CloseIcon}
          </Link>
        </div>

        <div className="uin-modal-body">
          <div className="uin-composer">{children({ askToLeave })}</div>
        </div>
      </div>

      <ConfirmDialog
        open={asking}
        title={`Leave this ${noun}?`}
        body={`What you have written is not saved anywhere, and closing loses it.`}
        confirmLabel="Leave it"
        cancelLabel="Keep writing"
        destructive
        onCancel={() => setAsking(false)}
        onConfirm={() => { setAsking(false); leave() }}
      />
    </div>
  )
}

/** The Cancel every one of these carries, so the three agree about what it looks
 *  like and what it asks before it goes. */
export function ComposeCancel({ closeHref, guard, askToLeave }: {
  closeHref: string
  guard: boolean
  askToLeave: () => void
}) {
  return (
    <Link
      className="uin-chip"
      href={closeHref}
      onClick={(event) => {
        if (!guard || opensElsewhere(event)) return
        event.preventDefault()
        askToLeave()
      }}
    >
      Cancel
    </Link>
  )
}
