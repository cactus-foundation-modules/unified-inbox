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

/** What an erase would take, counted from the tables the erase deletes from -
 *  so this panel and the deed cannot disagree. */
type ErasePreview = {
  name: string | null
  conversations: number
  messages: number
  attachments: number
  storedAttachments: number
  identities: string[]
  links: Array<{ moduleName: string; label: string | null }>
  outboundLogRows: number
}

type Props = {
  personId: string
  displayName: string | null
  notes: string | null
  identities: Identity[]
  merges: Merge[]
  canManage: boolean
}

type Found = { id: string; name: string | null; email: string | null; organisation: string | null; conversations: number }

/** See the erase panel below: the alert's own colour does not clear AA for a
 *  block of body text this long, and this is the one block that has to be read
 *  rather than glanced at. */
const ERASE_BODY = { color: 'var(--color-text)' } as const

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

  const [erasing, setErasing] = useState(false)
  const [preview, setPreview] = useState<ErasePreview | null>(null)

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

  // Asking what would go BEFORE offering the button that does it. The counts
  // come from the same queries the delete runs, so this is the deed described
  // rather than the deed guessed at.
  async function openErase() {
    if (erasing) { setErasing(false); return }
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/m/unified-inbox/people/${personId}/erase`)
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        setError(data?.error ?? 'That did not work.')
        return
      }
      setPreview(data.preview as ErasePreview)
      setErasing(true)
    } catch {
      setError('The site could not be reached, so nothing changed.')
    } finally {
      setBusy(false)
    }
  }

  async function erase() {
    if (!preview) return
    const label = preview.name || 'this person'
    const warning =
      `Erase everything the inbox holds about ${label}?\n\n` +
      `This removes ${preview.conversations} conversation${preview.conversations === 1 ? '' : 's'}, ` +
      `${preview.messages} message${preview.messages === 1 ? '' : 's'} and ` +
      `${preview.attachments} attached file${preview.attachments === 1 ? '' : 's'}, and cannot be undone.\n\n` +
      'It does NOT remove their orders, invoices, quotes, purchase orders or member account. ' +
      'Those are held elsewhere on this site and are not touched.'
    if (!window.confirm(warning)) return
    const ok = await call(`/api/m/unified-inbox/people/${personId}/erase`, { method: 'POST' })
    if (ok) { setErasing(false); setPreview(null) }
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
            {/* Both of these answer a request from the person themselves, which
                is why they sit together and behind the strongest permission. */}
            <a className="btn btn-secondary btn-sm" href={`/api/m/unified-inbox/people/${personId}/export`}>
              Download everything we hold
            </a>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                    onClick={openErase} aria-expanded={erasing}>
              Erase them
            </button>
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

      {canManage && erasing && preview && (
        // The alert is the right container - this is the most serious thing on
        // the screen - but the body text is set back to the ordinary text
        // colour rather than inheriting the alert's own red. Measured on the
        // rendered page, that red on its tinted ground is 4.4:1 at this size,
        // which is under AA, and this is precisely the block somebody must be
        // able to read carefully before they take a customer's history away.
        // The headings went the same way for the same reason - 15px at weight
        // 600 is not "large text" by the rule, so the red does not clear AA
        // there either. The alert's own tint, its border and the red button
        // carry the seriousness; the words only have to be readable.
        <div className="alert alert-danger" style={ERASE_BODY}>
          <p style={{ marginTop: 0, fontWeight: 600 }}>
            Erasing {preview.name || 'this person'} removes, from this inbox only:
          </p>
          <ul style={{ margin: '0 0 0.75rem 1.25rem', padding: 0 }}>
            <li>{preview.conversations} conversation{preview.conversations === 1 ? '' : 's'}, with {preview.messages} message{preview.messages === 1 ? '' : 's'}</li>
            <li>{preview.attachments} attached file{preview.attachments === 1 ? '' : 's'}{preview.storedAttachments > 0 ? `, ${preview.storedAttachments} of which we are storing a copy of` : ''}</li>
            <li>{preview.identities.length} address{preview.identities.length === 1 ? '' : 'es'}: {preview.identities.join(', ') || 'none on record'}</li>
            <li>Everything we worked out about them - their name, their notes and their organisation</li>
          </ul>
          <p style={{ marginTop: 0, fontWeight: 600 }}>It does NOT remove:</p>
          <ul style={{ margin: '0 0 0.75rem 1.25rem', padding: 0 }}>
            {preview.links.length > 0 && (
              <li>
                {preview.links.length} record{preview.links.length === 1 ? '' : 's'} attached to their
                conversations ({[...new Set(preview.links.map((l) => l.moduleName))].join(', ')}). The
                attachment goes; the record stays where it is.
              </li>
            )}
            <li>Their orders, invoices, quotes, purchase orders or member account. Those belong to the other parts of this site and have their own rules about keeping them.</li>
            {preview.outboundLogRows > 0 && (
              <li>
                The site&rsquo;s record that {preview.outboundLogRows} automated email{preview.outboundLogRows === 1 ? ' was' : 's were'} sent
                to them. That record holds the address and the subject and has never held a copy of what was said.
              </li>
            )}
          </ul>
          <p style={{ marginTop: 0 }}>This cannot be undone.</p>
          <div className="uin-thread-actions">
            <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={erase}>
              Erase them for good
            </button>
            <button type="button" className="uin-chip" disabled={busy} onClick={() => { setErasing(false); setPreview(null) }}>
              Leave it
            </button>
          </div>
        </div>
      )}

      {error && <div className="alert alert-danger">{error}</div>}
    </div>
  )
}
