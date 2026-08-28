'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'

// Correcting a person: their name, a note about them, and the two operations
// that move addresses about.
//
// Merging is the thing people regret, so it is the thing this screen works
// hardest at. It asks before it does it, it says exactly what will happen, and
// once it is done there is a Put it back button sitting there for as long as
// the merge stands. A split is the same operation from the other end and needs
// no confirmation, because it creates rather than destroys.

type Identity = { id: string; value: string; kind: string }
type Merge = { id: string; loserName: string | null }

type Props = {
  personId: string
  displayName: string | null
  notes: string | null
  identities: Identity[]
  merges: Merge[]
  canManage: boolean
}

type Found = { id: string; name: string | null; email: string | null; organisation: string | null; conversations: number }

export function PersonActions({ personId, displayName, notes, identities, merges, canManage }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(displayName ?? '')
  const [note, setNote] = useState(notes ?? '')

  const [merging, setMerging] = useState(false)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<Found[]>([])

  const [splitting, setSplitting] = useState(false)
  const [chosen, setChosen] = useState<string[]>([])

  const call = useCallback(async (url: string, init: RequestInit): Promise<boolean> => {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(url, init)
      if (!response.ok) {
        setError((await response.json().catch(() => null))?.error ?? 'That did not work.')
        return false
      }
      router.refresh()
      return true
    } catch {
      setError('The site could not be reached, so nothing changed.')
      return false
    } finally {
      setBusy(false)
    }
  }, [router])

  async function save() {
    const ok = await call(`/api/m/unified-inbox/people/${personId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: name.trim() || null, notes: note.trim() || null }),
    })
    if (ok) setEditing(false)
  }

  async function search() {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/m/unified-inbox/people?q=${encodeURIComponent(query)}`)
      const data = await response.json().catch(() => null)
      setFound(((data?.people ?? []) as Found[]).filter((p) => p.id !== personId))
    } catch {
      setError('The site could not be reached.')
    } finally {
      setBusy(false)
    }
  }

  async function merge(loser: Found) {
    const label = loser.name || loser.email || 'that person'
    const warning = `Merge ${label} into this person? Their ${loser.conversations} conversation${loser.conversations === 1 ? '' : 's'} and every address they have move across. You can put it back afterwards.`
    if (!window.confirm(warning)) return
    const ok = await call(`/api/m/unified-inbox/people/${personId}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loserId: loser.id }),
    })
    if (ok) { setMerging(false); setFound([]); setQuery('') }
  }

  async function undo(mergeId: string) {
    await call(`/api/m/unified-inbox/people/merges/${mergeId}/undo`, { method: 'POST' })
  }

  async function split() {
    const ok = await call(`/api/m/unified-inbox/people/${personId}/split`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identityIds: chosen }),
    })
    if (ok) { setSplitting(false); setChosen([]) }
  }

  return (
    <div style={{ display: 'grid', gap: '0.5rem' }}>
      <div className="uin-thread-actions">
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
          {editing ? 'Stop editing' : 'Edit their details'}
        </button>
        {canManage && (
          <>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                    onClick={() => setMerging((v) => !v)} aria-expanded={merging}>
              Merge somebody in
            </button>
            {identities.length > 1 && (
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                      onClick={() => setSplitting((v) => !v)} aria-expanded={splitting}>
                Split them apart
              </button>
            )}
          </>
        )}
      </div>

      {canManage && merges.length > 0 && (
        <div className="alert alert-info">
          {merges.map((m) => (
            <p key={m.id} style={{ margin: '0.25rem 0' }}>
              {m.loserName || 'Somebody'} was merged into this person.{' '}
              <button type="button" className="uin-chip" disabled={busy} onClick={() => undo(m.id)}>
                Put it back
              </button>
            </p>
          ))}
        </div>
      )}

      {editing && (
        <div className="uin-ctx-add" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
          <label htmlFor="uin-person-name">Their name</label>
          <input id="uin-person-name" value={name} disabled={busy}
                 onChange={(e) => setName(e.target.value)} placeholder="As you would write it" />
          <label htmlFor="uin-person-note">A note about them</label>
          <textarea id="uin-person-note" value={note} rows={3} disabled={busy}
                    onChange={(e) => setNote(e.target.value)} />
          <div className="uin-thread-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={save}>Save</button>
            <button type="button" className="uin-chip" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}

      {canManage && merging && (
        <div className="uin-ctx-add" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
          <label htmlFor="uin-merge-q">Who is the same person as this one?</label>
          <div className="uin-thread-actions">
            <input id="uin-merge-q" value={query} disabled={busy} placeholder="Their name or address"
                   onChange={(e) => setQuery(e.target.value)}
                   onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search() } }} />
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={search}>Search</button>
          </div>
          <ul className="uin-ctx-list">
            {found.map((p) => (
              <li key={p.id} className="uin-ctx-row">
                <div className="uin-ctx-main">
                  <span>{p.name || p.email || 'Somebody'}</span>
                  {p.organisation && <span className="uin-tag">{p.organisation}</span>}
                </div>
                <span className="uin-ctx-sub">{p.email}</span>
                <button type="button" className="uin-chip" disabled={busy} onClick={() => merge(p)}>
                  Merge into this person
                </button>
              </li>
            ))}
            {found.length === 0 && query && !busy && (
              <li className="uin-ctx-row"><span className="uin-ctx-sub">Nobody else matches that.</span></li>
            )}
          </ul>
        </div>
      )}

      {canManage && splitting && (
        <div className="uin-ctx-add" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
          <p className="uin-ctx-sub">
            Tick the addresses that belong to somebody else. They move to a new person, and so do
            the conversations they were had on.
          </p>
          {identities.map((identity) => (
            <label key={identity.id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={chosen.includes(identity.id)}
                disabled={busy}
                onChange={(e) => setChosen((current) =>
                  e.target.checked ? [...current, identity.id] : current.filter((c) => c !== identity.id))}
              />
              {identity.value}
            </label>
          ))}
          <div className="uin-thread-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || chosen.length === 0} onClick={split}>
              Move them out
            </button>
            <button type="button" className="uin-chip" disabled={busy} onClick={() => setSplitting(false)}>Cancel</button>
          </div>
        </div>
      )}

      {error && <div className="alert alert-danger">{error}</div>}
    </div>
  )
}
