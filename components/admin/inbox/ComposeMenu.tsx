'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { ChevronDownIcon, NoteIcon, PenIcon, PhoneIcon, SmsIcon } from './icons'

// Write a message, and the three other things you might have meant.
//
// A split button rather than four buttons: writing an email is what this is
// pressed for ninety-nine times out of a hundred, and burying it one level down
// a menu to make room for the other three would tax the common case to pay for
// the rare ones. So the button stays a button, and the arrow beside it opens
// the rest.
//
// A menu that offers something the site cannot do is worse than a shorter menu,
// so an entry with nowhere to go is not drawn: no texts without something to
// send them with, no calls without something to place them with. When all three
// are missing there is no arrow either, and what is left is exactly the button
// that was there before any of this existed.

export type ComposeMenuEntry = {
  key: string
  label: string
  href: string
  /** One line under the label. What it is for, in the words of somebody who
   *  does not work here. */
  hint: string
}

type Props = {
  /** Where the button itself goes: the ordinary new email. */
  composeHref: string
  entries: ComposeMenuEntry[]
}

const ICONS: Record<string, React.ReactNode> = {
  discussion: NoteIcon,
  call: PhoneIcon,
  sms: SmsIcon,
}

/** How wide the menu is drawn, in pixels, so the maths below can keep it on
 *  screen. Kept in step with .uin-compose-menu in inbox.css. */
const MENU_WIDTH = 240
/** Roughly what three entries come to. Only used to decide whether there is
 *  room below the button or whether it should open upwards - being a little out
 *  costs a slightly early flip, not a menu off the bottom of the window. */
const MENU_HEIGHT = 200
const GAP = 6

export function ComposeMenu({ composeHref, entries }: Props) {
  const [open, setOpen] = useState(false)
  // Where to draw it, in window coordinates. Fixed rather than absolute inside
  // the rail, because the rail SCROLLS - a column on a wide window and a strip
  // with overflow hidden on a narrow one - and a menu positioned inside it is a
  // menu with its bottom half cut off on a phone.
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  const place = useCallback(() => {
    const box = trigger.current?.getBoundingClientRect()
    if (!box) return
    const below = window.innerHeight - box.bottom
    setAt({
      top: below < MENU_HEIGHT + GAP && box.top > below
        ? Math.max(GAP, box.top - MENU_HEIGHT - GAP)
        : box.bottom + GAP,
      left: Math.max(GAP, Math.min(box.left, window.innerWidth - MENU_WIDTH - GAP)),
    })
  }, [])

  const close = useCallback((focusTrigger = false) => {
    setOpen(false)
    if (focusTrigger) trigger.current?.focus()
  }, [])

  // A press anywhere else puts it away. Pointerdown rather than click, so a
  // press that lands on a link elsewhere closes this before the page moves.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      // The menu itself is drawn into the page rather than in here (see below),
      // so "inside" is two boxes now: the split button, and the menu wherever it
      // has been put. Asking only the first is how pressing an entry closed the
      // menu out from under the press.
      const target = event.target as Node
      if (wrap.current?.contains(target) || menu.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close(true)
      }
    }
    // Scrolling or resizing moves the button out from under the menu. Putting
    // it away is the honest answer, and cheaper than following it about.
    const dismiss = () => setOpen(false)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [close, open])

  // Opening with the keyboard lands on the first entry, which is what a menu
  // opened by a keyboard is for.
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('a')?.focus()
  }, [open])

  /** Up and down walk the entries and stop at the ends, which is what a menu of
   *  three does; wrapping round a list this short reads as a bug. */
  const onMenuKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('a') ?? [])
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'ArrowDown'
      ? Math.min(items.length - 1, at + 1)
      : Math.max(0, at - 1)
    items[next]?.focus()
  }, [])

  if (entries.length === 0) {
    return (
      <Link className="uin-rail-compose" href={composeHref} aria-label="Write a message">
        {PenIcon}
      </Link>
    )
  }

  return (
    <div className="uin-compose-split" ref={wrap}>
      <Link className="uin-rail-compose uin-rail-compose-main" href={composeHref} aria-label="Write a message">
        {PenIcon}
      </Link>
      <button
        type="button"
        className="uin-rail-compose uin-rail-compose-more"
        ref={trigger}
        aria-label="Something other than an email"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (!open) place()
          setOpen((was) => !was)
        }}
      >
        {ChevronDownIcon}
      </button>

      {/* Into the page itself, like every other panel in here that is drawn at
          window coordinates. The head of the rail this button sits in is
          position: sticky, a sticky box makes a stacking context, and a fixed
          menu inside one cannot get out of it however high its z-index - which
          put this under the pinned head of the conversation and the note bar,
          behind the middle and right columns. Never open on a first render, so
          the server and the browser agree about the markup. */}
      {open && at && typeof document !== 'undefined' && createPortal(
        <div
          className="uin-compose-menu"
          role="menu"
          ref={menu}
          style={{ top: at.top, left: at.left }}
          onKeyDown={onMenuKeyDown}
        >
          {entries.map((entry) => (
            <Link
              key={entry.key}
              role="menuitem"
              className="uin-compose-menu-item"
              href={entry.href}
              onClick={() => setOpen(false)}
            >
              <span className="uin-compose-menu-icon" aria-hidden="true">{ICONS[entry.key] ?? NoteIcon}</span>
              <span className="uin-compose-menu-words">
                <span className="uin-compose-menu-label">{entry.label}</span>
                <span className="uin-compose-menu-hint">{entry.hint}</span>
              </span>
            </Link>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}
