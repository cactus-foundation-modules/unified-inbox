'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'

// A contact record over the open conversation.
//
// Pressing the name under a conversation's subject used to change who the
// conversation is with - a rare job, sitting on the one word people press to
// find out who somebody is. The name now opens their record, here, without
// losing the conversation behind it; changing who it is with is the pencil
// beside the name (see ThreadContactPicker).
//
// The record itself is the same page the address book shows (PersonView),
// drawn inside the card with its own head, so it carries its own close cross
// and its own edit, merge and export buttons. Nothing is typed in here, so
// unlike the composers this needs no "are you sure": Escape and a press on the
// background simply close it.

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

type Props = {
  /** The conversation, with the record dropped. */
  closeHref: string
  /** Who it is, for the dialog's accessible name. */
  label: string
  children: ReactNode
}

export function ContactModal({ closeHref, label, children }: Props) {
  const router = useRouter()
  const card = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    card.current?.focus()
    return () => { document.body.style.overflow = previous }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // A dialog or menu opened from inside the record owns its own Escape.
        if (event.defaultPrevented) return
        event.preventDefault()
        router.push(closeHref, { scroll: false })
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
      if (!inside.contains(active) || active === inside) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
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
  }, [closeHref, router])

  return (
    <div
      className="uin-modal"
      onMouseDown={(event) => {
        // Only a press on the background itself, never one that started inside
        // the card and was dragged out of it.
        if (event.target === event.currentTarget) router.push(closeHref, { scroll: false })
      }}
    >
      <div
        className="uin-modal-card uin-modal-card-contact"
        role="dialog"
        aria-modal="true"
        aria-label={`Contact record: ${label}`}
        tabIndex={-1}
        ref={card}
      >
        {children}
      </div>
    </div>
  )
}
