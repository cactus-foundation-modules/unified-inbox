'use client'

import { useCallback, useId, useMemo, useRef, useState } from 'react'
import { initialsFor } from '@/modules/unified-inbox/lib/list'

// The To line on a discussion: the colleagues it is being put to.
//
// A discussion goes nowhere, so there is no address to type - only a name to
// find. The list is small, known and already on the page, so this filters what
// it was handed rather than asking the server on every keystroke.
//
// Chosen names become tokens with a cross on them rather than staying as text
// in the box. Text in a box has to be parsed back into people, which is how a
// misspelt name becomes a colleague nobody told; a token either is somebody or
// was never added.
//
// The keyboard does what a suggestion menu is expected to do: the arrows move
// the highlight, Return and Tab take it, Backspace on an empty box picks the
// last token off, and Escape shuts the menu WITHOUT closing the dialog around
// it - losing a half-written discussion to the keystroke meant to dismiss a
// menu is not a trade anybody would make.

export type Colleague = { id: string; name: string }

/** How many names the menu offers at once. Past eight it is a scroll, and a
 *  scroll is a list nobody reads the bottom of. */
const SHOWN = 8

type Props = {
  id: string
  /** Everybody who could be put on it. */
  colleagues: Colleague[]
  /** Who is on it, by id, in the order they were added. */
  chosen: string[]
  onChange: (ids: string[]) => void
  placeholder?: string
}

export function ColleagueField({ id, colleagues, chosen, onChange, placeholder }: Props) {
  const listId = useId()
  const input = useRef<HTMLInputElement>(null)
  const [term, setTerm] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)

  const byId = useMemo(() => new Map(colleagues.map((c) => [c.id, c])), [colleagues])
  const tokens = useMemo(
    () => chosen.map((cid) => byId.get(cid)).filter((c): c is Colleague => Boolean(c)),
    [byId, chosen],
  )

  // Never offers somebody already on it: a menu that hands you the same person
  // twice is a menu you have to read carefully.
  const shown = useMemo(() => {
    const q = term.trim().toLowerCase()
    return colleagues
      .filter((c) => !chosen.includes(c.id))
      .filter((c) => (q ? c.name.toLowerCase().includes(q) : true))
      .slice(0, SHOWN)
  }, [chosen, colleagues, term])

  const menuOpen = open && shown.length > 0

  const add = useCallback((person: Colleague) => {
    onChange([...chosen, person.id])
    setTerm('')
    setActive(0)
    // Back in the box ready for the next name, which is what somebody adding
    // three people is about to do.
    window.requestAnimationFrame(() => input.current?.focus())
  }, [chosen, onChange])

  const remove = useCallback((personId: string) => {
    onChange(chosen.filter((cid) => cid !== personId))
  }, [chosen, onChange])

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
          add(picked)
          return
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        return
      }
    }
    if (event.key === 'Backspace' && term === '' && chosen.length > 0) {
      event.preventDefault()
      remove(chosen[chosen.length - 1]!)
    }
  }

  return (
    <div className="uin-people">
      {tokens.map((person) => (
        <span className="uin-chip uin-chip-clear uin-person-chip" key={person.id}>
          <span className="uin-chip-clear-text">{person.name}</span>
          <button
            type="button"
            className="uin-chip-clear-x"
            aria-label={`Take ${person.name} off`}
            onClick={() => remove(person.id)}
          >
            &times;
          </button>
        </span>
      ))}

      <input
        id={id}
        ref={input}
        type="text"
        role="combobox"
        aria-expanded={menuOpen}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={menuOpen ? `${listId}-${active}` : undefined}
        value={term}
        placeholder={tokens.length > 0 ? '' : placeholder}
        autoComplete="off"
        onChange={(e) => { setTerm(e.target.value); setOpen(true); setActive(0) }}
        onFocus={() => setOpen(true)}
        // A click on a name takes the focus off the box before the click lands,
        // so the menu cannot close on blur alone. It closes a tick later, by
        // which time the click has been dealt with.
        onBlur={() => { window.setTimeout(() => setOpen(false), 120) }}
        onKeyDown={onKeyDown}
      />

      {menuOpen && (
        <ul className="uin-suggestions" id={listId} role="listbox" aria-label="Colleagues">
          {shown.map((person, index) => (
            <li
              key={person.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              data-active={index === active ? '1' : undefined}
              className="uin-suggestion"
              onMouseEnter={() => setActive(index)}
              onMouseDown={(e) => { e.preventDefault(); add(person) }}
            >
              <span className="uin-suggestion-avatar" aria-hidden="true">
                {initialsFor(person.name)}
              </span>
              <span className="uin-suggestion-text">
                <span className="uin-suggestion-name">{person.name}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
