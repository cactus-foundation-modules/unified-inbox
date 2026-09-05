'use client'

import { useId } from 'react'

// The rows a contact card is made of, shared by the person's card and the
// organisation's so the two cannot drift into looking like different screens.
//
// Same markup as the composer's To and Cc lines (see .uin-fields in styles.tsx):
// a bordered block with borderless lines inside it, because a box drawn round
// every line would be fourteen boxes inside a box and the row itself already
// says where to type.

export type CardFieldProps = {
  label: string
  value: string
  onChange: (value: string) => void
  type?: 'text' | 'email' | 'tel' | 'url'
  placeholder?: string
  /** A note beside the box for the one or two fields that need one. Most do
   *  not: a field called "Postcode" explains itself. */
  hint?: string
  disabled?: boolean
  autoFocus?: boolean
}

export function CardField({
  label, value, onChange, type = 'text', placeholder, hint, disabled, autoFocus,
}: CardFieldProps) {
  const id = useId()
  return (
    <div className="uin-field-row">
      <label htmlFor={id}>{label}</label>
      <div className="uin-field-control">
        <input
          id={id}
          type={type}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(event) => onChange(event.target.value)}
        />
        {hint && <span className="uin-field-hint">{hint}</span>}
      </div>
    </div>
  )
}

/** The one field that is a paragraph rather than a line. Kept out of the
 *  bordered block: a box that grows as somebody types pushes every row under it
 *  about, and notes are the last thing on both cards anyway. */
export function CardNotes({
  value, onChange, disabled,
}: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const id = useId()
  return (
    <div className="uin-card-notes">
      <label htmlFor={id}>Notes</label>
      <textarea
        id={id}
        rows={4}
        value={value}
        disabled={disabled}
        placeholder="Anything worth remembering about them."
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}

/** A heading over a run of rows. Plain text rather than a legend, because the
 *  block underneath is a div rather than a fieldset - a fieldset's own border
 *  cannot be talked out of the way in every browser, and the block already has
 *  one of its own. */
export function CardSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="uin-card-section">
      <h4 className="uin-ctx-heading">{label}</h4>
      <div className="uin-fields">{children}</div>
    </section>
  )
}
