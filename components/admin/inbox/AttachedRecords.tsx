'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { LinkKind } from '@/modules/unified-inbox/lib/linking'
import type { RecordLink } from '@/modules/unified-inbox/lib/types'
import { recordHref, recordLabel } from '@/modules/unified-inbox/lib/record-links'
import { ChevronDownIcon } from './icons'
import { AddLink, LinkActions, type LinkKindChoice } from './LinkActions'

// What this conversation is about, on one line under the actions: "Purchase
// order PO-0023, Order DW0234".
//
// One line and never two. The names of the site's own records are the shortest
// true answer to "what is this thread", so they belong where the subject and
// the actions are rather than at the bottom of a panel nobody scrolls to - but
// a conversation with nine orders on it must not push the message itself down
// the screen. So the line is clipped with an ellipsis and the whole list lives
// behind the arrow, which is also where anything is attached or taken off.

type Props = {
  threadId: string
  /** The admin root, so a stored link becomes a real address. */
  adminPath: string
  links: RecordLink[]
  canEdit: boolean
  /** What may be attached here at all: the record kinds whose module is
   *  installed and whose records this viewer may see. */
  kinds: LinkKindChoice[]
  /** Which of them the picker opens on, decided from what the inbox is used
   *  for. */
  defaultKind: LinkKind | null
}

/** How wide the menu is drawn, in pixels, so the maths below can keep it on
 *  screen. Kept in step with .uin-attached-menu in styles.tsx. */
const MENU_WIDTH = 300
/** Roughly what a couple of records and the attach form come to. Only used to
 *  decide whether to open downwards or up - being a little out costs an early
 *  flip, not a menu off the bottom of the window. */
const MENU_HEIGHT = 260
const GAP = 6

export function AttachedRecords({ threadId, adminPath, links, canEdit, kinds, defaultKind }: Props) {
  const [open, setOpen] = useState(false)
  // Where to draw it, in window coordinates. Fixed rather than absolute,
  // because this row sits in a header that is pinned to the top of a pane which
  // scrolls its own contents - a menu positioned inside it is a menu clipped by
  // it. Same reason and the same shape as ComposeMenu.
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  const canAttach = canEdit && kinds.length > 0

  const place = useCallback(() => {
    const box = trigger.current?.getBoundingClientRect()
    if (!box) return
    const below = window.innerHeight - box.bottom
    setAt({
      top: below < MENU_HEIGHT + GAP && box.top > below
        ? Math.max(GAP, box.top - MENU_HEIGHT - GAP)
        : box.bottom + GAP,
      // Hung off the right-hand edge of the arrow, which is the edge it was
      // opened from, then pulled back onto the screen if that would overhang.
      left: Math.max(GAP, Math.min(box.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - GAP)),
    })
  }, [])

  const close = useCallback((focusTrigger = false) => {
    setOpen(false)
    if (focusTrigger) trigger.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    // Pointerdown rather than click, so a press that lands on a link elsewhere
    // closes this before the page moves.
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!wrap.current?.contains(target) && !menu.current?.contains(target)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close(true)
      }
    }
    // Scrolling the page moves the arrow out from under the menu, so the menu
    // goes away. Scrolling INSIDE it does not - the list of records to attach
    // is a scrolling list, and a menu that shuts itself the moment somebody
    // scrolls the thing they came to read is a menu nobody can use.
    const dismiss = (event: Event) => {
      if (menu.current?.contains(event.target as Node)) return
      setOpen(false)
    }
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

  // Nothing on it and nothing that could go on it - no shop, no purchasing, or
  // no permission to see either. A row saying "nothing attached" beside an
  // arrow that opens an empty menu is a row that only ever wastes a line.
  if (links.length === 0 && !canAttach) return null

  const summary = links.length > 0
    ? links.map(recordLabel).join(', ')
    : 'Nothing attached'

  return (
    <div className="uin-attached" ref={wrap}>
      {/* The title carries the whole list, because the line itself may be cut
          short - and being cut short is exactly when somebody wants the rest. */}
      <span className="uin-attached-line" title={summary}>{summary}</span>
      <button
        type="button"
        className="uin-attached-more"
        ref={trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={canAttach
          ? 'What is attached to this conversation, and attach something'
          : 'What is attached to this conversation'}
        onClick={() => {
          if (!open) place()
          setOpen((was) => !was)
        }}
      >
        {ChevronDownIcon}
      </button>

      {open && at && (
        <div
          className="uin-attached-menu"
          ref={menu}
          role="dialog"
          aria-label="Attached to this conversation"
          style={{ top: at.top, left: at.left }}
        >
          {links.length > 0 ? (
            <ul className="uin-ctx-list">
              {links.map((link) => {
                const href = recordHref(link)
                const label = recordLabel(link)
                return (
                  <li key={link.id} className="uin-ctx-row">
                    <div className="uin-ctx-main">
                      {href ? (
                        <Link href={`/${adminPath}/${href}`} onClick={() => setOpen(false)}>{label}</Link>
                      ) : (
                        <span>{label}</span>
                      )}
                      {link.linkedBy === 'auto' && (
                        <span className="uin-tag" title="We spotted this reference in the message. Take it off if it is wrong.">
                          Found automatically
                        </span>
                      )}
                    </div>
                    {canEdit && <LinkActions linkId={link.id} label={label} onThread />}
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="uin-ctx-sub">Nothing attached yet.</p>
          )}
          {canAttach && <AddLink threadId={threadId} kinds={kinds} defaultKind={defaultKind} />}
        </div>
      )}
    </div>
  )
}
