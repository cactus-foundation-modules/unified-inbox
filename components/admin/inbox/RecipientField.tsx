'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { initialsFor } from '@/modules/unified-inbox/lib/list'

// The To and Cc lines on a new message, with the addresses this inbox actually
// deals with offered underneath.
//
// Three decisions worth writing down, because each of them is a way to make a
// suggestion menu worse than no suggestion menu:
//
//   It suggests before a key is pressed. Landing in an empty To box with the
//   eight people this address has been dealing with already listed is the whole
//   point - most messages go to somebody you wrote to last week, and asking
//   somebody to remember enough of an address to start typing it is asking them
//   to do the work the site was supposed to do.
//
//   It completes the FRAGMENT, not the field. The line holds several addresses
//   separated by commas, so picking a name replaces the part being typed and
//   leaves the rest of the line alone. Replacing the whole value is how a
//   suggestion menu eats the two recipients somebody had already entered.
//
//   Return means two different things and has to pick the right one. With the
//   menu open it takes the highlighted suggestion; with it closed it moves to
//   the next line, which is what the rest of this form does. Getting that the
//   wrong way round either traps somebody in the To box or throws the menu's
//   answer away every time.
//
// The list is whatever the server offers, ordered by how recently this inbox
// dealt with them, and it never reaches past the inboxes the reader may open -
// see the route. Nothing here is cached across mounts: it is one small query,
// and a stale menu offering somebody who has since been erased is worse than a
// request.

export type Suggestion = {
  address: string
  name: string | null
  organisation: string | null
}

type Props = {
  id: string
  value: string
  onChange: (value: string) => void
  /** The inbox being written from, so the suggestions are its correspondents
   *  rather than the whole site's. Null while no address has been chosen. */
  inboxId: string | null
  placeholder: string
  /** What Return does when the menu is closed - the existing move-to-next-line
   *  behaviour, handed in so this component does not need to know the form. */
  onEnter: (event: React.KeyboardEvent<HTMLInputElement>) => void
  'aria-label'?: string
}

/** The part of the line being typed: everything after the last separator. */
function fragment(value: string, caret: number): { text: string; start: number } {
  const upto = value.slice(0, caret)
  const start = Math.max(upto.lastIndexOf(','), upto.lastIndexOf(';')) + 1
  return { text: value.slice(start, caret).trim(), start }
}

/** The line with `address` written into the fragment the caret is sitting in,
 *  and a comma ready for the next one. */
function replaceFragment(value: string, caret: number, address: string): string {
  const { start } = fragment(value, caret)
  const before = value.slice(0, start)
  const after = value.slice(caret)
  const spacer = before && !/[\s]$/.test(before) ? ' ' : ''
  return `${before}${spacer}${address}, ${after.trimStart()}`.trimEnd() + ' '
}

/** Addresses already on the line, so the menu never offers one twice. */
function alreadyOn(value: string): Set<string> {
  return new Set(
    value.split(/[,;]/).map((part) => part.trim().toLowerCase()).filter(Boolean)
  )
}

export function RecipientField({
  id, value, onChange, inboxId, placeholder, onEnter, ...rest
}: Props) {
  const listId = useId()
  const input = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [active, setActive] = useState(0)
  const [term, setTerm] = useState('')
  const [loading, setLoading] = useState(false)

  // What the caret is sitting in, recomputed on every keystroke rather than
  // held: an arrow key moves the caret without changing the value, and a menu
  // filtered on a fragment the caret has left is a menu answering the wrong
  // question.
  const refreshTerm = useCallback(() => {
    const el = input.current
    if (!el) return
    setTerm(fragment(el.value, el.selectionStart ?? el.value.length).text)
  }, [])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const timer = window.setTimeout(async () => {
      setLoading(true)
      try {
        const params = new URLSearchParams()
        if (inboxId) params.set('inbox', inboxId)
        if (term) params.set('q', term)
        const response = await fetch(`/api/m/unified-inbox/admin/recipients?${params}`)
        const body = await response.json().catch(() => null)
        if (cancelled) return
        setSuggestions(Array.isArray(body?.suggestions) ? body.suggestions : [])
        setActive(0)
      } catch {
        // A suggestion menu is a convenience. It fails by having nothing to
        // suggest, never by getting in the way of somebody typing an address.
        if (!cancelled) setSuggestions([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, term ? 140 : 0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [open, term, inboxId])

  const shown = useMemo(() => {
    const on = alreadyOn(value)
    return suggestions.filter((s) => !on.has(s.address.toLowerCase())).slice(0, 8)
  }, [suggestions, value])

  const menuOpen = open && shown.length > 0

  const choose = useCallback((suggestion: Suggestion) => {
    const el = input.current
    const caret = el?.selectionStart ?? value.length
    onChange(replaceFragment(value, caret, suggestion.address))
    setOpen(false)
    setTerm('')
    // Back to the box with the caret at the end, ready for the next one.
    window.requestAnimationFrame(() => {
      const box = input.current
      if (!box) return
      box.focus()
      box.setSelectionRange(box.value.length, box.value.length)
    })
  }, [onChange, value])

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (menuOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActive((i) => (i + 1) % shown.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((i) => (i - 1 + shown.length) % shown.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const picked = shown[active]
        if (picked) {
          event.preventDefault()
          choose(picked)
          return
        }
      }
      if (event.key === 'Escape') {
        // Shuts the menu and stops there. The dialog around this closes on
        // Escape too, and losing a half-written message to the keystroke that
        // was meant to dismiss a menu is not a trade anybody would make.
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        return
      }
    }
    if (event.key === 'Enter') onEnter(event)
  }

  return (
    <div className="uin-recipient-field">
      <input
        {...rest}
        id={id}
        ref={input}
        type="text"
        role="combobox"
        aria-expanded={menuOpen}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={menuOpen ? `${listId}-${active}` : undefined}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => { onChange(e.target.value); setOpen(true); refreshTerm() }}
        onKeyUp={refreshTerm}
        onClick={refreshTerm}
        onFocus={() => { setOpen(true); refreshTerm() }}
        // A click on a suggestion takes the focus off the input before the
        // click lands, so the menu cannot close on blur alone. It closes on the
        // next tick instead, by which time the click has been dealt with.
        onBlur={() => { window.setTimeout(() => setOpen(false), 120) }}
        onKeyDown={onKeyDown}
      />

      {menuOpen && (
        <ul className="uin-suggestions" id={listId} role="listbox" aria-label="Suggested recipients">
          {!term && (
            <li className="uin-suggestions-head" aria-hidden="true">
              Recently in touch
            </li>
          )}
          {shown.map((suggestion, index) => (
            <li
              key={suggestion.address}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              data-active={index === active ? '1' : undefined}
              className="uin-suggestion"
              onMouseEnter={() => setActive(index)}
              onMouseDown={(e) => { e.preventDefault(); choose(suggestion) }}
            >
              <span className="uin-suggestion-avatar" aria-hidden="true">
                {initialsFor(suggestion.name || suggestion.address)}
              </span>
              <span className="uin-suggestion-text">
                <span className="uin-suggestion-name">{suggestion.name || suggestion.address}</span>
                <span className="uin-suggestion-meta">
                  {suggestion.name ? suggestion.address : null}
                  {suggestion.name && suggestion.organisation ? ' · ' : null}
                  {suggestion.organisation}
                </span>
              </span>
            </li>
          ))}
          {loading && <li className="uin-suggestions-foot" aria-hidden="true">Looking…</li>}
        </ul>
      )}
    </div>
  )
}
