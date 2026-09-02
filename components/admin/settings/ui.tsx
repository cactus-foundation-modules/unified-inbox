'use client'

import { useId, type CSSProperties, type ReactNode } from 'react'
import type { Note } from './types'

// The handful of shapes every panel on this screen is built out of.
//
// They exist because the screen used to be one file of 1,600 lines in which the
// same bordered box, the same muted hint and the same tick-box-with-an-
// explanation were written out by hand a dozen times each, and no two of them
// quite matched. Every colour here is a token, so the whole screen follows the
// admin into dark mode without a second palette.

export const MUTED = { color: 'var(--color-text-muted)' } as const

/** The heading at the top of a panel. Reads as a heading rather than as the
 *  tiny uppercase label this screen used to use: the tab strip already says
 *  which panel you are on, so the heading is free to say what it is for. */
export const PANEL_TITLE: CSSProperties = {
  fontSize: 'var(--text-lg)',
  fontWeight: 'var(--font-semibold)',
  color: 'var(--color-text)',
  lineHeight: 'var(--leading-lg)',
  margin: 0,
}

/** The heading on a group of fields inside a form. */
export const GROUP_TITLE: CSSProperties = {
  fontSize: 'var(--text-sm)',
  fontWeight: 'var(--font-semibold)',
  color: 'var(--color-text)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  margin: 0,
}

/** The look of a `.field` label, for the places where the thing being named is
 *  a group of controls rather than one of them. A `<label>` there would have
 *  nothing to point at, which is how a screen reader ends up announcing a row
 *  of unnamed tickboxes. */
export const GROUP_LABEL: CSSProperties = {
  display: 'block',
  fontSize: 'var(--text-sm)',
  fontWeight: 'var(--font-medium)',
  color: 'var(--color-text)',
  lineHeight: 'var(--leading-sm)',
}

/** Kept for the Webhooks panel, which was written against it. */
export const SETTINGS_SECTION_HEADING = PANEL_TITLE

export function NoteAlert({ note }: { note: Note | null }) {
  if (!note) return null
  return (
    <div
      className={note.tone === 'ok' ? 'alert alert-success' : 'alert alert-danger'}
      role={note.tone === 'ok' ? 'status' : 'alert'}
      style={{ marginBottom: '1rem' }}
    >
      {note.text}
    </div>
  )
}

/** One panel of the settings screen: a heading, a sentence saying what it is
 *  for, and whatever the panel puts inside it. */
export function Panel({ title, blurb, children, style }: {
  title: ReactNode
  blurb?: ReactNode
  children: ReactNode
  style?: CSSProperties
}) {
  return (
    <section className="card" style={{ marginBottom: '1.5rem', ...style }}>
      <h3 style={PANEL_TITLE}>{title}</h3>
      {blurb && (
        <p className="field-hint" style={{ margin: '0.375rem 0 1.25rem', maxWidth: '58ch' }}>{blurb}</p>
      )}
      {children}
    </section>
  )
}

/** A named group of fields inside a long form. The forms on this screen ask for
 *  a dozen things at once, and a dozen boxes in a column is exactly the thing
 *  that made this page hard to read. */
export function FieldGroup({ title, hint, children, first }: {
  title: string
  hint?: ReactNode
  children: ReactNode
  first?: boolean
}) {
  return (
    <fieldset
      style={{
        border: 'none',
        padding: 0,
        margin: first ? '0 0 1.5rem' : '1.5rem 0',
        minInlineSize: 0,
      }}
    >
      <legend style={{ ...GROUP_TITLE, padding: 0, marginBottom: hint ? '0.25rem' : '0.75rem' }}>{title}</legend>
      {hint && <p className="field-hint" style={{ margin: '0 0 0.75rem', maxWidth: '58ch' }}>{hint}</p>}
      {children}
    </fieldset>
  )
}

/** Two fields side by side where there is room, stacked where there is not. A
 *  server name and its port are one answer, not two, and giving the port a
 *  whole row of its own made the form a third longer than it needed to be. */
export function FieldRow({ children, template = 'repeat(auto-fit, minmax(min(100%, 14rem), 1fr))' }: {
  children: ReactNode
  template?: string
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: template, gap: '0 1rem', alignItems: 'start' }}>
      {children}
    </div>
  )
}

/** A tick box with its label beside it and, usually, a sentence underneath
 *  saying what ticking it does. Written out by hand a dozen times before this
 *  existed, and no two of them were indented the same. */
export function CheckField({ label, checked, onChange, hint, disabled }: {
  label: ReactNode
  checked: boolean
  onChange: (next: boolean) => void
  hint?: ReactNode
  disabled?: boolean
}) {
  return (
    <div className="field">
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', fontWeight: 400, cursor: disabled ? 'default' : 'pointer' }}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          style={{ marginTop: '0.2rem', flexShrink: 0 }}
        />
        <span>{label}</span>
      </label>
      {hint && (
        // Lined up under the label rather than under the box, so the sentence
        // reads as belonging to the words next to it.
        <p className="field-hint" style={{ margin: '0.125rem 0 0 1.5rem', maxWidth: '58ch' }}>{hint}</p>
      )}
    </div>
  )
}

/** One thing in a list of things - a mail account, an address. A bordered box
 *  rather than the hairline rule this screen used to draw between them, which
 *  at a glance made six accounts look like one paragraph. */
export function ListRow({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        padding: '0.875rem 1rem',
        marginBottom: '0.75rem',
        background: 'var(--color-bg)',
      }}
    >
      {children}
    </div>
  )
}

/** The name of a thing, whatever it is worth saying about it, and its buttons -
 *  laid out so the buttons stay together on a narrow screen instead of
 *  wrapping one at a time down the right-hand side. */
export function ListRowHeader({ title, subtitle, badges, actions, meta }: {
  title: ReactNode
  subtitle?: ReactNode
  badges?: ReactNode
  actions?: ReactNode
  meta?: ReactNode
}) {
  return (
    <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between' }}>
      <div style={{ minWidth: '14rem', flex: '1 1 20rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 'var(--text-base)' }}>{title}</strong>
          {badges}
        </div>
        {subtitle && (
          <div className="field-hint" style={{ marginTop: '0.25rem', overflowWrap: 'anywhere' }}>{subtitle}</div>
        )}
        {meta && <div className="field-hint" style={{ marginTop: '0.25rem' }}>{meta}</div>}
      </div>
      {actions && (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', flexShrink: 0 }}>{actions}</div>
      )}
    </div>
  )
}

export type BadgeTone = 'ok' | 'bad' | 'plain' | 'info'

const BADGE_CLASS: Record<BadgeTone, string> = {
  ok: 'badge badge-success',
  bad: 'badge badge-danger',
  plain: 'badge badge-gray',
  info: 'badge badge-info',
}

export function Chip({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={BADGE_CLASS[tone]}>{children}</span>
}

/** The form that opens when something is being added or edited, marked off from
 *  the list above it. It used to be a hairline and a lot of hope. */
export function EditPanel({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId()
  return (
    <section
      aria-labelledby={headingId}
      style={{
        border: '1px solid var(--color-border-strong)',
        borderRadius: 'var(--radius-md)',
        padding: '1.25rem',
        marginTop: '1rem',
        background: 'var(--color-bg-subtle)',
      }}
    >
      <h4 id={headingId} style={{ ...PANEL_TITLE, fontSize: 'var(--text-base)', marginBottom: '1rem' }}>{title}</h4>
      {children}
    </section>
  )
}

/** The row of buttons at the foot of a form, always in the same order and
 *  always in the same place. */
export function FormActions({ children }: { children: ReactNode }) {
  return (
    <div style={{
      display: 'flex',
      gap: '0.75rem',
      flexWrap: 'wrap',
      marginTop: '1.25rem',
      paddingTop: '1rem',
      borderTop: '1px solid var(--color-border)',
    }}>
      {children}
    </div>
  )
}

/** Nothing here yet, and what to do about it. An empty list used to be one grey
 *  line that said so and stopped there. */
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        border: '1px dashed var(--color-border)',
        borderRadius: 'var(--radius-md)',
        padding: '1.25rem',
        textAlign: 'center',
        color: 'var(--color-text-secondary)',
        fontSize: 'var(--text-sm)',
        lineHeight: 'var(--leading-base)',
      }}
    >
      {children}
    </div>
  )
}
