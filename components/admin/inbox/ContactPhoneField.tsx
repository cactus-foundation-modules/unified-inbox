'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { initialsFor } from '@/modules/unified-inbox/lib/list'

// The box you say who to ring in, with the address book underneath it.
//
// Nobody remembers a phone number. They remember a name, and the number is
// already written down here from the last time that person got in touch - so
// the box takes either, and typing "wend" is expected to find Wendy's number
// rather than be refused as a bad number.
//
// Three things worth writing down, because each is a way to make this worse
// than a plain box:
//
//   It only asks the address book when there is a LETTER in what has been
//   typed. Somebody dialling 020 8138 0512 gets a request per keystroke
//   otherwise, and a menu of nobody for their trouble: numbers are filed in
//   international form, so a number typed the way people type one would not
//   match a stored one anyway.
//
//   It offers only contacts who have a number on them. A menu whose entries
//   put nothing in the box when clicked is a menu that has wasted a click.
//
//   Return means take the highlighted one when the menu is open, and nothing
//   at all when it is not. Escape shuts the menu and stops there - the dialog
//   around this closes on Escape too, and losing the form to the keystroke that
//   was meant to dismiss a menu is not a trade anybody would make.
//
// The list is whatever the contacts route offers, which is bounded by the
// permission to read this hub at all. Nothing is cached across mounts: it is
// one small query, and a stale menu offering somebody since erased is worse
// than a request.

type Suggestion = {
  id: string
  name: string
  organisation: string | null
  phone: string
}

type Props = {
  id: string
  value: string
  onChange: (value: string) => void
  /** A number taken off the menu, handed over separately so the form can tidy
   *  it into international form the same way it tidies a typed one. */
  onPick: (phone: string) => void
  placeholder: string
}

/** Worth asking the address book about: a name has letters in it, a phone
 *  number does not. Unicode-aware, because surnames are. */
const HAS_LETTER = /\p{L}/u

/** How many the menu shows. Eight is a menu; thirty is a directory. */
const SHOWN = 8

/** One row of the contacts route read into a suggestion, or null when it is not
 *  one - no name to show, or no number to put in the box. Read a field at a
 *  time rather than trusted wholesale: this arrives over the wire, and a row
 *  that has lost its number would otherwise become a menu entry that dials the
 *  word "undefined". */
function suggestionFrom(row: unknown): Suggestion | null {
  if (typeof row !== 'object' || row === null) return null
  const { id, name, organisation, phone } = row as {
    id?: unknown; name?: unknown; organisation?: unknown; phone?: unknown
  }
  if (typeof id !== 'string' || typeof phone !== 'string' || !phone.trim()) return null
  const org = typeof organisation === 'string' && organisation ? organisation : null
  // Whatever there is to call them by. A contact filed under a number alone is
  // still worth offering - it is the number you are after.
  const label = (typeof name === 'string' && name) || org || phone
  return { id, name: label, organisation: org, phone }
}

export function ContactPhoneField({ id, value, onChange, onPick, placeholder }: Props) {
  const listId = useId()
  const input = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  // What came back, and the term it answers. Held together rather than apart so
  // the menu can be sure it is showing answers to the question on screen: a
  // list kept in its own box goes on offering the last name's contacts for a
  // frame or two after the box has been retyped.
  const [results, setResults] = useState<{ term: string; items: Suggestion[] }>({ term: '', items: [] })
  const [active, setActive] = useState(0)
  const [loading, setLoading] = useState(false)

  const term = value.trim()
  const asking = open && HAS_LETTER.test(term)

  useEffect(() => {
    if (!asking) return
    let cancelled = false
    const timer = window.setTimeout(async () => {
      setLoading(true)
      try {
        const params = new URLSearchParams({ q: term, perPage: '25', sort: 'name' })
        const response = await fetch(`/api/m/unified-inbox/people?${params}`)
        const body = await response.json().catch(() => null)
        if (cancelled) return
        const people: unknown[] = Array.isArray(body?.people) ? body.people : []
        const items = people
          .map(suggestionFrom)
          .filter((s): s is Suggestion => s !== null)
          .slice(0, SHOWN)
        setResults({ term, items })
        setActive(0)
      } catch {
        // A suggestion menu is a convenience. It fails by having nothing to
        // suggest, never by getting in the way of somebody typing a number.
        if (!cancelled) setResults({ term, items: [] })
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 160)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [asking, term])

  const suggestions = results.term === term ? results.items : []
  const menuOpen = asking && suggestions.length > 0

  const choose = useCallback((suggestion: Suggestion) => {
    onPick(suggestion.phone)
    setOpen(false)
    window.requestAnimationFrame(() => {
      const box = input.current
      if (!box) return
      box.focus()
      box.setSelectionRange(box.value.length, box.value.length)
    })
  }, [onPick])

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!menuOpen) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((i) => (i + 1) % suggestions.length)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((i) => (i - 1 + suggestions.length) % suggestions.length)
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      const picked = suggestions[active]
      if (picked) {
        event.preventDefault()
        choose(picked)
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <div className="uin-recipient-field">
      <input
        id={id}
        ref={input}
        // Named, and named out of Safari's vocabulary. Safari guesses what a box
        // is for from its name - and with no name at all it guesses from the id,
        // then the placeholder, then the label. Guess "one-time code" and it
        // drops the From Messages chip on top; guess "person" and it drops the
        // contacts card there instead. Either one lands on this field's own
        // suggestion menu, which knows the number and is the point of the box.
        //
        // So: nothing here - name, id, placeholder, label - may say sms, code,
        // otp, passcode, name, phone, tel, email or address. autocomplete="off"
        // is asked for as well, but it is a request Safari overrules whenever
        // its guess is confident, so the wording is what actually does the work.
        name="uin-lookup"
        // Text rather than tel: a name is typed in here as often as a number,
        // and tel hands a phone a keypad with no letters on it.
        type="text"
        role="combobox"
        aria-expanded={menuOpen}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={menuOpen ? `${listId}-${active}` : undefined}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => { onChange(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        // A click on a suggestion takes the focus off the input before the
        // click lands, so the menu cannot close on blur alone. It closes on the
        // next tick instead, by which time the click has been dealt with.
        onBlur={() => { window.setTimeout(() => setOpen(false), 120) }}
        onKeyDown={onKeyDown}
      />

      {menuOpen && (
        <ul className="uin-suggestions" id={listId} role="listbox" aria-label="Contacts with a number">
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              data-active={index === active ? '1' : undefined}
              className="uin-suggestion"
              onMouseEnter={() => setActive(index)}
              onMouseDown={(e) => { e.preventDefault(); choose(suggestion) }}
            >
              <span className="uin-suggestion-avatar" aria-hidden="true">
                {initialsFor(suggestion.name)}
              </span>
              <span className="uin-suggestion-text">
                <span className="uin-suggestion-name">{suggestion.name}</span>
                <span className="uin-suggestion-meta">
                  {suggestion.phone}
                  {suggestion.organisation ? ` · ${suggestion.organisation}` : null}
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
