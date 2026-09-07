'use client'

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { ContextHint } from '@/modules/unified-inbox/lib/adapters/types'
import type { LinkKind } from '@/modules/unified-inbox/lib/linking'
import type { RecordLink } from '@/modules/unified-inbox/lib/types'
import { recordDestination, recordLabel } from '@/modules/unified-inbox/lib/record-links'
import { ChevronDownIcon } from './icons'
import { AddLink, LinkActions, type LinkKindChoice } from './LinkActions'

// What this conversation is about, on one line under the actions: "Purchase
// order PO-0023, Order DW0234".
//
// Called context rather than attachments, and deliberately: a message can carry
// a file, and a conversation can be about an order, and calling both of them an
// attachment meant nobody could tell from the word which one was meant.
//
// One line and never two. The names of the site's own records are the shortest
// true answer to "what is this thread", so they belong where the subject and
// the actions are rather than at the bottom of a panel nobody scrolls to - but
// a conversation with nine orders on it must not push the message itself down
// the screen. So the line is clipped with an ellipsis and the whole list lives
// behind the arrow, which is also where anything is added or taken off.
//
// The names on that line are the links themselves, not a summary of them.
// Reading them and then having to open a menu to press one of them was two
// steps to do the obvious thing with the thing already in front of you. Each
// one opens in a new tab: the point of following an order from a conversation
// is to read the order WHILE answering the message, and taking the whole pane
// off to the shop loses the half-written reply behind it.

type Props = {
  threadId: string
  /** The admin root, so a stored link becomes a real address. */
  adminPath: string
  /** What on the site the conversation came from, when its channel says so -
   *  the name of the form it was typed into, say. It sits with the records
   *  because it answers the same question they do, and it is NOT one of them:
   *  nobody put it there, it does not open anything, and it cannot be taken
   *  off, because taking it off would be claiming the enquiry came from
   *  somewhere else. So it is the one thing on this line that is not a link. */
  sourceLabel: string | null
  /** Standing facts about whoever is writing - "Existing customer" - from the
   *  same adapters the records come from. They sit on this line because they
   *  answer the same question the records do, and like the source label they are
   *  not records: nobody attached them and there is nothing to take off. The
   *  adapter that offers one drops it as soon as a record of the kind that
   *  answers the question exactly is attached, so the vague version and the
   *  precise one are never on the line together. */
  hints: ContextHint[]
  links: RecordLink[]
  /** Where the ones with a page of their own on the shop actually open, keyed
   *  by link id. A product is on the conversation because somebody quoted it,
   *  so following it opens the page the customer was sent rather than the
   *  editor behind it. Worked out on the server - see lib/record-urls.ts. */
  publicUrls: Record<string, string>
  canEdit: boolean
  /** What may be added here at all: the record kinds whose module is
   *  installed and whose records this viewer may see. */
  kinds: LinkKindChoice[]
  /** Which of them the picker opens on, decided from what the inbox is used
   *  for. */
  defaultKind: LinkKind | null
  /** Drawn as the arrow on its own, with no line beside it.
   *
   *  A conversation with nothing attached and nothing to say about where it came
   *  from used to get a bordered strip of its own reading "No context yet",
   *  which is a row of the reading pane spent saying that there is nothing to
   *  say. In that case the arrow moves up onto the end of the line that already
   *  says "Email - General Enquiries - 1 message", where it costs nothing and is
   *  still where somebody would look to attach the first one. */
  compact?: boolean
}

/** How wide the menu is drawn, in pixels, so the maths below can keep it on
 *  screen. Kept in step with .uin-ctxbar-menu in styles.tsx. */
const MENU_WIDTH = 300
/** Roughly what a couple of records and the add form come to. Only used to
 *  decide whether to open downwards or up - being a little out costs an early
 *  flip, not a menu off the bottom of the window. */
const MENU_HEIGHT = 260
const GAP = 6

/**
 * Whether a press landed inside a dialog this menu put up.
 *
 * The question asked before a piece of context comes off renders into the end of
 * the page rather than into the menu, which is what stops it being clipped by a
 * pane that scrolls its own contents - and which also puts it OUTSIDE both
 * elements the check above looks in. So pressing "Take it off" read as a press
 * somewhere else, the menu closed on pointerdown, the dialog went with it, and
 * the click never reached the button that was under the cursor a moment before.
 * Nothing happened, and nothing said why.
 *
 * `.uin-modal` is the class ConfirmDialog gives its backdrop; see that file.
 */
function inOwnDialog(target: Node | null): boolean {
  return target instanceof Element && !!target.closest('.uin-modal')
}

export function ContextRecords({
  threadId, adminPath, sourceLabel, hints, links, publicUrls, canEdit, kinds, defaultKind,
  compact = false,
}: Props) {
  const [open, setOpen] = useState(false)
  // Where to draw it, in window coordinates. Fixed rather than absolute,
  // because this row sits in a header that is pinned to the top of a pane which
  // scrolls its own contents - a menu positioned inside it is a menu clipped by
  // it. Same reason and the same shape as ComposeMenu.
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  const canAdd = canEdit && kinds.length > 0

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
      if (inOwnDialog(target)) return
      if (!wrap.current?.contains(target) && !menu.current?.contains(target)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close(true)
      }
    }
    // Scrolling the page moves the arrow out from under the menu, so the menu
    // goes away. Scrolling INSIDE it does not - the list of records to add is a
    // scrolling list, and a menu that shuts itself the moment somebody scrolls
    // the thing they came to read is a menu nobody can use.
    const dismiss = (event: Event) => {
      if (menu.current?.contains(event.target as Node)) return
      if (inOwnDialog(event.target as Node)) return
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
  // no permission to see either. A row saying "no context" beside an arrow that
  // opens an empty menu is a row that only ever wastes a line.
  if (!sourceLabel && hints.length === 0 && links.length === 0 && !canAdd) return null

  const parts = [
    ...(sourceLabel ? [sourceLabel] : []),
    ...hints.map((hint) => hint.label),
    ...links.map(recordLabel),
  ]
  const summary = parts.length > 0 ? parts.join(', ') : 'No context yet'
  // Whether anything at all precedes the records on the line, so the first of
  // them knows whether to write a comma in front of itself.
  const beforeLinks = (sourceLabel ? 1 : 0) + hints.length

  return (
    <div className={compact ? 'uin-ctxbar uin-ctxbar-compact' : 'uin-ctxbar'} ref={wrap}>
      {/* The title carries the whole list, because the line itself may be cut
          short - and being cut short is exactly when somebody wants the rest. */}
      {!compact && (
      <span className="uin-ctxbar-line" title={summary}>
        {sourceLabel && <span className="uin-ctxbar-source">{sourceLabel}</span>}
        {hints.map((hint, index) => (
          <Fragment key={hint.id}>
            {(index > 0 || sourceLabel) && ', '}
            <Link
              href={`/${adminPath}/${hint.href}`}
              target="_blank"
              rel="noreferrer"
              title={hint.title}
            >
              {hint.label}
            </Link>
          </Fragment>
        ))}
        {links.length > 0
          ? links.map((link, index) => {
            const href = recordDestination(link, adminPath, publicUrls)
            const label = recordLabel(link)
            return (
              <Fragment key={link.id}>
                {(index > 0 || beforeLinks > 0) && ', '}
                {href ? (
                  <Link href={href} target="_blank" rel="noreferrer">
                    {label}
                  </Link>
                ) : label}
              </Fragment>
            )
          })
          : beforeLinks === 0 && summary}
      </span>
      )}
      <button
        type="button"
        className="uin-ctxbar-more"
        ref={trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={canAdd
          ? 'The context on this conversation, and add some'
          : 'The context on this conversation'}
        onClick={() => {
          if (!open) place()
          setOpen((was) => !was)
        }}
      >
        {ChevronDownIcon}
      </button>

      {open && at && (
        <div
          className="uin-ctxbar-menu"
          ref={menu}
          role="dialog"
          aria-label="Context on this conversation"
          style={{ top: at.top, left: at.left }}
        >
          {sourceLabel && (
            <p className="uin-ctx-sub">Came from {sourceLabel}.</p>
          )}
          {links.length > 0 || hints.length > 0 ? (
            <ul className="uin-ctx-list">
              {hints.map((hint) => (
                <li key={hint.id} className="uin-ctx-row">
                  <div className="uin-ctx-main">
                    <Link
                      href={`/${adminPath}/${hint.href}`}
                      target="_blank"
                      rel="noreferrer"
                      title={hint.title}
                      onClick={() => setOpen(false)}
                    >
                      {hint.label}
                    </Link>
                  </div>
                  {/* The whole of the fact, once there is room for it. On the
                      line above there is only room for the label. */}
                  <span className="uin-ctx-sub">{hint.title}</span>
                </li>
              ))}
              {links.map((link) => {
                const href = recordDestination(link, adminPath, publicUrls)
                const label = recordLabel(link)
                return (
                  <li key={link.id} className={canEdit ? 'uin-ctx-row uin-ctx-row--x' : 'uin-ctx-row'}>
                    {canEdit && <LinkActions linkId={link.id} label={label} onThread />}
                    <div className="uin-ctx-main">
                      {href ? (
                        <Link
                          href={href}
                          target="_blank"
                          rel="noreferrer"
                          onClick={() => setOpen(false)}
                        >
                          {label}
                        </Link>
                      ) : (
                        <span>{label}</span>
                      )}
                      {link.linkedBy === 'auto' && (
                        <span className="uin-tag" title="We spotted this reference in the message. Take it off if it is wrong.">
                          Found automatically
                        </span>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="uin-ctx-sub">No context on this yet.</p>
          )}
          {canAdd && <AddLink threadId={threadId} kinds={kinds} defaultKind={defaultKind} />}
        </div>
      )}
    </div>
  )
}
