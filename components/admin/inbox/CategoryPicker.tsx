'use client'

import { useState } from 'react'

// Which labels one contact wears.
//
// Ticks rather than a text box, because the whole value of a category is that
// two people spell it the same way - and a box somebody types into produces
// "Supplier", "supplier" and "Suppliers" inside a fortnight. Typing is still
// there for the one case it is needed: a label that does not exist yet.
//
// The new one is added to what is ticked here and not saved anywhere until the
// card itself is saved. A category created by pressing Add on a card that is
// then abandoned would be a category nobody asked for.

type Props = {
  /** Every category the site has, in the order somebody put them in. */
  available: string[]
  /** The names ticked on this card. */
  value: string[]
  onChange: (names: string[]) => void
  disabled?: boolean
}

export function CategoryPicker({ available, value, onChange, disabled }: Props) {
  const [adding, setAdding] = useState(false)
  const [fresh, setFresh] = useState('')

  // Anything already on the card that is not in the list yet - a label typed a
  // moment ago and not saved. Shown alongside the rest so it can be unticked
  // again without saving first.
  const known = new Set(available.map((name) => name.toLowerCase()))
  const extra = value.filter((name) => !known.has(name.toLowerCase()))
  const all = [...available, ...extra]

  const isOn = (name: string) => value.some((v) => v.toLowerCase() === name.toLowerCase())

  const toggle = (name: string) => {
    onChange(isOn(name)
      ? value.filter((v) => v.toLowerCase() !== name.toLowerCase())
      : [...value, name])
  }

  const add = () => {
    const name = fresh.trim().replace(/\s+/g, ' ')
    if (!name) return
    if (!isOn(name)) onChange([...value, name])
    setFresh('')
    setAdding(false)
  }

  return (
    <div className="uin-field-row">
      <label id="uin-categories-label">Categories</label>
      <div className="uin-field-control uin-categories">
        {all.length === 0 && !adding && (
          <span className="uin-ctx-sub">None yet. Add the first one.</span>
        )}
        {all.length > 0 && (
          <div className="uin-category-chips" role="group" aria-labelledby="uin-categories-label">
            {all.map((name) => (
              <button
                key={name}
                type="button"
                className="uin-category-chip"
                aria-pressed={isOn(name)}
                disabled={disabled}
                onClick={() => toggle(name)}
              >
                {name}
              </button>
            ))}
          </div>
        )}
        {adding ? (
          <span className="uin-category-new">
            <label className="sr-only" htmlFor="uin-category-new">A new category</label>
            <input
              id="uin-category-new"
              value={fresh}
              disabled={disabled}
              autoFocus
              placeholder="Supplier"
              onChange={(event) => setFresh(event.target.value)}
              onKeyDown={(event) => {
                // Return here means "add this one", not "save the card". A card
                // that saved itself halfway through typing a label was the
                // first thing anybody did with this.
                if (event.key !== 'Enter') return
                event.preventDefault()
                add()
              }}
            />
            <button type="button" className="uin-field-add" disabled={disabled} onClick={add}>Add</button>
            <button type="button" className="uin-field-add" disabled={disabled} onClick={() => { setFresh(''); setAdding(false) }}>
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" className="uin-field-add" disabled={disabled} onClick={() => setAdding(true)}>
            New category
          </button>
        )}
      </div>
    </div>
  )
}
