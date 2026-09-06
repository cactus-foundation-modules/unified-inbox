'use client'

import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState,
  type ReactNode,
} from 'react'

// One button that opens one panel, and everything that has to be true about a
// panel opened from a button: it goes away when you press elsewhere, it goes
// away on Escape and hands the focus back, the arrow keys walk it, and it stays
// on the screen.
//
// Drawn fixed and positioned from the button rather than inside it, for the
// reason the compose menu already learned the hard way: every one of these
// hangs off a header pinned inside a pane that scrolls its own contents, so a
// panel positioned inside that pane is a panel clipped by it.
//
// Five of these appeared on the conversation at once - the message menu, the
// reply icon's siblings, who it is with, what it is set to, and when it comes
// back - and five private copies of this is four places to get it subtly wrong.

const GAP = 6
/** Enough to open the right way up before the panel has been measured. The
 *  layout effect below corrects it on the same frame, so being out here costs a
 *  guess, not a flicker. */
const ASSUMED_HEIGHT = 240

type Props = {
  /** What is drawn on the button. */
  label: ReactNode
  /** Said instead of the label, for a button that is only an icon. */
  ariaLabel?: string
  title?: string
  /** The button's own classes. Defaults to the small secondary button the rest
   *  of this screen uses. */
  className?: string
  disabled?: boolean
  /** How wide the panel is drawn, in pixels. */
  width?: number
  /** Which edge of the button the panel lines up with. 'end' for anything at
   *  the right-hand end of a row, so the panel opens inwards. */
  align?: 'start' | 'end'
  /** Extra classes on the panel itself. */
  panelClassName?: string
  /** What is in the panel. Anything inside it can shut it with
   *  `useDropdownClose`, and a MenuItem shuts it by itself. */
  children: ReactNode
}

/** The way anything inside a panel shuts the panel it is in. A context rather
 *  than a render prop: handing the contents a callback means calling them
 *  while rendering, with a function that reaches for the trigger's ref, and
 *  reading a ref during a render is how a focus ends up handed back to a
 *  button that has since been replaced. */
const DropdownCloseContext = createContext<(() => void) | null>(null)

export function useDropdownClose(): () => void {
  const close = useContext(DropdownCloseContext)
  if (!close) throw new Error('Used outside a Dropdown')
  return close
}

export function Dropdown({
  label, ariaLabel, title, className, disabled, width = 240, align = 'start',
  panelClassName, children,
}: Props) {
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  const place = useCallback((height: number) => {
    const box = trigger.current?.getBoundingClientRect()
    if (!box) return
    const room = window.innerHeight - box.bottom - GAP
    // Below when it fits, above when it does not and there is more room up
    // there, and pinned to whichever edge is nearer when it fits in neither -
    // the panel caps its own height in CSS, so it can always be put somewhere.
    const top = height <= room || box.top - GAP < room
      ? Math.min(box.bottom + GAP, Math.max(GAP, window.innerHeight - height - GAP))
      : Math.max(GAP, box.top - height - GAP)
    const wanted = align === 'end' ? box.right - width : box.left
    setAt({ top, left: Math.max(GAP, Math.min(wanted, window.innerWidth - width - GAP)) })
  }, [align, width])

  const close = useCallback((focusTrigger = false) => {
    setOpen(false)
    if (focusTrigger) trigger.current?.focus()
  }, [])

  /** What everything inside the panel is given. Shutting it hands the focus
   *  back to the button it came from, which is the whole of what a keyboard
   *  needs from a menu that has done its job. */
  const closeAndFocus = useCallback(() => close(true), [close])

  // Measured once it is on the page, so a tall panel - the calendar is four
  // hundred pixels of it - opens the right way up rather than off the bottom.
  useLayoutEffect(() => {
    if (!open) return
    place(panel.current?.offsetHeight ?? ASSUMED_HEIGHT)
  }, [open, place])

  useEffect(() => {
    if (!open) return
    // Pointerdown rather than click, so a press that lands on a link elsewhere
    // shuts this before the page moves.
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (wrap.current?.contains(target) || panel.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close(true)
    }
    // Scrolling or resizing takes the button out from under the panel. Putting
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
  // opened by a keyboard is for. Only entries marked as such: a calendar's
  // thirty-odd day buttons are not a menu and taking the focus onto one of them
  // would be nobody's idea of where the menu starts.
  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>('[data-menu-item]')?.focus()
  }, [open])

  /** Up and down walk the entries and stop at the ends. Wrapping round a list
   *  this short reads as a bug. */
  const onPanelKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('[data-menu-item]') ?? [])
    if (items.length === 0) return
    event.preventDefault()
    const from = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'ArrowDown'
      ? Math.min(items.length - 1, from + 1)
      : Math.max(0, from - 1)
    items[next]?.focus()
  }, [])

  return (
    <div className="uin-dropdown" ref={wrap}>
      <button
        type="button"
        ref={trigger}
        className={className ?? 'btn btn-secondary btn-sm'}
        aria-label={ariaLabel}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (!open) place(ASSUMED_HEIGHT)
          setOpen((was) => !was)
        }}
      >
        {label}
      </button>

      {open && at && (
        <div
          className={panelClassName ? `uin-menu ${panelClassName}` : 'uin-menu'}
          ref={panel}
          role="menu"
          style={{ top: at.top, left: at.left, width }}
          onKeyDown={onPanelKeyDown}
        >
          <DropdownCloseContext.Provider value={closeAndFocus}>
            {children}
          </DropdownCloseContext.Provider>
        </div>
      )}
    </div>
  )
}

/** One choice on a panel. The hint is the quiet half on the right - the day a
 *  snooze lands on, the name it is already with - and is left off where there
 *  is nothing worth saying.
 *
 *  Pressing one shuts the panel, because a menu that stays open over the thing
 *  it has just changed is a menu in the way. `keepOpen` is for the one entry
 *  that does not choose anything: Day & Time swaps what is in the panel. */
export function MenuItem({
  onClick, disabled, children, hint, icon, after, keepOpen,
}: {
  onClick: () => void
  disabled?: boolean
  children: ReactNode
  hint?: ReactNode
  icon?: ReactNode
  after?: ReactNode
  keepOpen?: boolean
}) {
  const close = useDropdownClose()
  return (
    <button
      type="button"
      role="menuitem"
      data-menu-item=""
      className="uin-menu-item"
      disabled={disabled}
      onClick={() => {
        if (!keepOpen) close()
        onClick()
      }}
    >
      {icon && <span className="uin-menu-item-icon" aria-hidden="true">{icon}</span>}
      <span className="uin-menu-item-label">{children}</span>
      {hint !== undefined && <span className="uin-menu-item-hint">{hint}</span>}
      {after && <span className="uin-menu-item-after" aria-hidden="true">{after}</span>}
    </button>
  )
}
