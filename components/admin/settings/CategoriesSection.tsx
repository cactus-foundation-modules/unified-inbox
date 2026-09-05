'use client'

import { useState } from 'react'
import type { Caller, ContactCategoryRow } from './types'
import { EmptyState, FieldGroup, ListRow, ListRowHeader, MUTED } from './ui'

// The labels contacts can be filed under, managed.
//
// Adding one is not here: a category is typed onto a contact's card, at the
// moment somebody realises they want it, and a list you have to go to Settings
// to add to is a list that stays as whoever set the site up first imagined it.
// What IS here is the two things you cannot sensibly do from a card - renaming
// one across everybody wearing it, and getting rid of one nobody uses - plus
// the order they appear in everywhere else.

export function CategoriesSection({ categories, busy, call }: {
  categories: ContactCategoryRow[]
  busy: boolean
  call: Caller
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [name, setName] = useState('')

  const rename = async (id: string) => {
    const clean = name.trim()
    if (!clean) return
    const ok = await call(
      `/api/m/unified-inbox/categories/${id}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: clean }) },
      'Renamed.',
    )
    if (ok !== null) setEditing(null)
  }

  const remove = async (row: ContactCategoryRow) => {
    await call(
      `/api/m/unified-inbox/categories/${row.id}`,
      { method: 'DELETE' },
      `“${row.name}” is gone. Everybody who was in it is exactly as they were.`,
    )
  }

  const move = async (index: number, by: -1 | 1) => {
    const to = index + by
    if (to < 0 || to >= categories.length) return
    const ids = categories.map((c) => c.id)
    const [moved] = ids.splice(index, 1)
    ids.splice(to, 0, moved!)
    await call(
      '/api/m/unified-inbox/categories/reorder',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) },
      null,
    )
  }

  return (
    <FieldGroup
      title="Categories"
      hint={<>
        The labels you file contacts under - Supplier, Trade customer, Haulier, whatever suits.
        You add one by typing it onto a contact, or by naming it while importing a file. This is
        where you rename one or get rid of one. Removing a category keeps everybody who was in
        it; they simply stop showing the label.
      </>}
    >
      {categories.length === 0 ? (
        <EmptyState>
          None yet. Open any contact, press <strong>Edit their details</strong> and add the first one.
        </EmptyState>
      ) : (
        categories.map((row, index) => (
          <ListRow key={row.id}>
            <ListRowHeader
              title={editing === row.id ? (
                <input
                  value={name}
                  disabled={busy}
                  autoFocus
                  aria-label={`A new name for ${row.name}`}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') { event.preventDefault(); void rename(row.id) }
                    if (event.key === 'Escape') setEditing(null)
                  }}
                />
              ) : row.name}
              subtitle={
                <span style={MUTED}>
                  {row.people === 0
                    ? 'Nobody is in it'
                    : row.people === 1 ? '1 contact' : `${row.people} contacts`}
                </span>
              }
              actions={editing === row.id ? (
                <>
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => { void rename(row.id) }}>
                    Save
                  </button>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy || index === 0}
                    aria-label={`Move ${row.name} up`}
                    onClick={() => { void move(index, -1) }}
                  >
                    &uarr;
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy || index === categories.length - 1}
                    aria-label={`Move ${row.name} down`}
                    onClick={() => { void move(index, 1) }}
                  >
                    &darr;
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy}
                    onClick={() => { setEditing(row.id); setName(row.name) }}
                  >
                    Rename
                  </button>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { void remove(row) }}>
                    Remove
                  </button>
                </>
              )}
            />
          </ListRow>
        ))
      )}
    </FieldGroup>
  )
}
