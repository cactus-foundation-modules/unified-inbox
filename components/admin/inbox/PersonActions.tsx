'use client'

import { createContext, useCallback, useContext, useState } from 'react'
import type { ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { ConfirmDialog } from './ConfirmDialog'

// Correcting a person: their name, a note about them, and the two operations
// that move addresses about.
//
// Merging is the thing people regret, so it is the thing this screen works
// hardest at. It asks before it does it, it says exactly what will happen, and
// once it is done there is a Put it back button sitting there for as long as
// the merge stands. A split is the same operation from the other end and needs
// no confirmation, because it creates rather than destroys.
//
// WHY THIS IS THREE COMPONENTS AND NOT ONE
// The buttons belong in the person's header, beside their name: "who is this
// and what can I do about them" is one question and wants one answer in one
// place. What those buttons open does not belong there. The erase preview alone
// is most of a screenful of counts and lists, and while it was part of the
// header the header was most of the pane - a slab of form under the name, with
// the timeline it is all about shoved off the bottom of the pane before you had
// read a word of it. So the state lives in a provider wrapped round the whole
// page, the bar goes in the header, and the panels go at the top of the body
// underneath it. A header is for saying who somebody is and offering the
// handful of things you can do about them; it is not somewhere to put a form.

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
  children: ReactNode
}

type Found = { id: string; name: string | null; email: string | null; organisation: string | null; conversations: number }

/** See the erase panel below: the alert's own colour does not clear AA for a
 *  block of body text this long, and this is the one block that has to be read
 *  rather than glanced at. */
const ERASE_BODY = { color: 'var(--color-text)' } as const

/** What the other parts of this site are called in front of the person who owns
 *  it. The erase preview used to name them the way the code does, so somebody
 *  deciding whether to take a customer's history away was shown
 *  "quote-for-shop". */
const MODULE_LABELS: Record<string, string> = {
  shop: 'the shop',
  'purchase-orders': 'purchasing',
  'quote-for-shop': 'quotes',
  'uk-bookkeeping': 'the bookkeeping',
}

/** Where the attached records live, in English and without repeating itself.
 *  Anything with no name of its own is left out rather than shown raw: the
 *  sentence reads perfectly well with no list after it. */
function whereRecordsLive(links: Array<{ moduleName: string }>): string {
  const named: string[] = []
  for (const link of links) {
    const label = MODULE_LABELS[link.moduleName]
    if (label && !named.includes(label)) named.push(label)
  }
  return named.join(', ')
}

type PersonActionsApi = {
  personId: string
  identities: Identity[]
  merges: Merge[]
  canManage: boolean
  busy: boolean
  error: string
  editing: boolean
  toggleEditing: () => void
  closeEditing: () => void
  name: string
  setName: (value: string) => void
  note: string
  setNote: (value: string) => void
  save: () => void
  merging: boolean
  toggleMerging: () => void
  closeMerging: () => void
  query: string
  setQuery: (value: string) => void
  found: Found[]
  searched: boolean
  search: () => void
  askMerge: (loser: Found) => void
  mergeCandidate: Found | null
  cancelMerge: () => void
  merge: () => void
  undo: (mergeId: string) => void
  splitting: boolean
  toggleSplitting: () => void
  closeSplitting: () => void
  chosen: string[]
  toggleChosen: (identityId: string, on: boolean) => void
  split: () => void
  erasing: boolean
  openErase: () => void
  closeErase: () => void
  preview: ErasePreview | null
  askErase: () => void
  eraseAsked: boolean
  cancelErase: () => void
  erase: () => void
}

const PersonActionsContext = createContext<PersonActionsApi | null>(null)

function usePersonActions(): PersonActionsApi {
  const value = useContext(PersonActionsContext)
  if (!value) throw new Error('The person bar and panels have to sit inside PersonActionsProvider.')
  return value
}

export function PersonActionsProvider({
  personId, displayName, notes, identities, merges, canManage, children,
}: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(displayName ?? '')
  const [note, setNote] = useState(notes ?? '')

  const [merging, setMerging] = useState(false)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<Found[]>([])
  // Whether a search has actually run. Without it the panel answered "nobody
  // matches" the moment somebody typed their first character, before it had
  // been asked anything.
  const [searched, setSearched] = useState(false)
  const [mergeCandidate, setMergeCandidate] = useState<Found | null>(null)

  const [splitting, setSplitting] = useState(false)
  const [chosen, setChosen] = useState<string[]>([])

  const [erasing, setErasing] = useState(false)
  const [preview, setPreview] = useState<ErasePreview | null>(null)
  const [eraseAsked, setEraseAsked] = useState(false)

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
      if (!response.ok) {
        // Not allowed and found nobody used to read exactly the same, which is
        // the worst way for a permission to go wrong: it looks like an answer.
        setError(response.status === 401 || response.status === 403
          ? 'You are not allowed to look people up.'
          : 'That search would not run. Try again in a moment.')
        setFound([])
        setSearched(false)
        return
      }
      const data = await response.json().catch(() => null)
      setFound(((data?.people ?? []) as Found[]).filter((p) => p.id !== personId))
      setSearched(true)
    } catch {
      setError('The site could not be reached.')
      setFound([])
      setSearched(false)
    } finally {
      setBusy(false)
    }
  }

  async function merge() {
    const loser = mergeCandidate
    if (!loser) return
    const ok = await call(`/api/m/unified-inbox/people/${personId}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loserId: loser.id }),
    })
    setMergeCandidate(null)
    if (ok) { setMerging(false); setFound([]); setQuery(''); setSearched(false) }
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
    const ok = await call(`/api/m/unified-inbox/people/${personId}/erase`, { method: 'POST' })
    setEraseAsked(false)
    if (ok) { setErasing(false); setPreview(null) }
  }

  const api: PersonActionsApi = {
    personId,
    identities,
    merges,
    canManage,
    busy,
    error,
    editing,
    toggleEditing: () => setEditing((v) => !v),
    closeEditing: () => setEditing(false),
    name,
    setName,
    note,
    setNote,
    save: () => { void save() },
    merging,
    toggleMerging: () => setMerging((v) => !v),
    closeMerging: () => setMerging(false),
    query,
    setQuery: (value: string) => { setQuery(value); setSearched(false) },
    found,
    searched,
    search: () => { void search() },
    askMerge: (loser: Found) => setMergeCandidate(loser),
    mergeCandidate,
    cancelMerge: () => { if (!busy) setMergeCandidate(null) },
    merge: () => { void merge() },
    undo: (mergeId: string) => { void undo(mergeId) },
    splitting,
    toggleSplitting: () => setSplitting((v) => !v),
    closeSplitting: () => setSplitting(false),
    chosen,
    toggleChosen: (identityId: string, on: boolean) => setChosen((current) =>
      on ? [...current, identityId] : current.filter((c) => c !== identityId)),
    split: () => { void split() },
    erasing,
    openErase: () => { void openErase() },
    closeErase: () => { setErasing(false); setPreview(null) },
    preview,
    askErase: () => setEraseAsked(true),
    eraseAsked,
    cancelErase: () => { if (!busy) setEraseAsked(false) },
    erase: () => { void erase() },
  }

  return <PersonActionsContext.Provider value={api}>{children}</PersonActionsContext.Provider>
}

/** Where the panels live, so a button in the header can point at what it opens.
 *  They are no longer siblings - that is the whole point of the split - so
 *  without this there is nothing joining the two for anybody driving the page by
 *  keyboard. */
const PANELS_ID = 'uin-person-panels'

/** The buttons, and nothing else. This is what sits in the header, beside the
 *  person's name. */
export function PersonActionsBar() {
  const a = usePersonActions()
  return (
    <div className="uin-thread-actions">
      <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy}
              onClick={a.toggleEditing} aria-expanded={a.editing} aria-controls={PANELS_ID}>
        {a.editing ? 'Stop editing' : 'Edit their details'}
      </button>
      {a.canManage && (
        <>
          <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy}
                  onClick={a.toggleMerging} aria-expanded={a.merging} aria-controls={PANELS_ID}>
            Merge somebody in
          </button>
          {a.identities.length > 1 && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy}
                    onClick={a.toggleSplitting} aria-expanded={a.splitting} aria-controls={PANELS_ID}>
              Split them apart
            </button>
          )}
          {/* Both of these answer a request from the person themselves, which
              is why they sit together and behind the strongest permission. */}
          <a className="btn btn-secondary btn-sm" href={`/api/m/unified-inbox/people/${a.personId}/export`}>
            Download everything we hold
          </a>
          <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy}
                  onClick={a.openErase} aria-expanded={a.erasing} aria-controls={PANELS_ID}>
            Erase them
          </button>
        </>
      )}
    </div>
  )
}

/** Everything those buttons open, plus whatever went wrong. Below the header,
 *  where it is allowed to be as tall as it needs to be. */
export function PersonActionsPanels() {
  const a = usePersonActions()
  const everyAddress = a.chosen.length > 0 && a.chosen.length >= a.identities.length
  const mergeLabel = a.mergeCandidate?.name || a.mergeCandidate?.email || 'That person'
  const recordHomes = a.preview ? whereRecordsLive(a.preview.links) : ''

  // Nothing open and nothing wrong: no block at all, rather than an empty one
  // holding the timeline down by the height of a gap.
  const anything = !!a.error
    || a.editing
    || !!a.mergeCandidate
    || a.eraseAsked
    || (a.canManage && (a.merges.length > 0 || a.merging || a.splitting || (a.erasing && !!a.preview)))
  if (!anything) return null

  return (
    <div className="uin-actions" id={PANELS_ID}>
      {/* Beside what failed rather than at the foot of the pane: a failed merge
          used to report itself under four hundred pixels of erase preview. */}
      {a.error && <div className="alert alert-danger" role="alert">{a.error}</div>}

      {a.canManage && a.merges.length > 0 && (
        <div className="alert alert-info">
          {a.merges.map((m) => (
            <p key={m.id} style={{ margin: '0.25rem 0' }}>
              {m.loserName || 'Somebody'} was merged into this person.{' '}
              <button type="button" className="uin-chip" disabled={a.busy} onClick={() => a.undo(m.id)}>
                Put it back
              </button>
            </p>
          ))}
        </div>
      )}

      {a.editing && (
        <div className="uin-ctx-add uin-ctx-add-stacked">
          <label htmlFor="uin-person-name">Their name</label>
          <input id="uin-person-name" value={a.name} disabled={a.busy}
                 onChange={(e) => a.setName(e.target.value)} placeholder="As you would write it" />
          <label htmlFor="uin-person-note">A note about them</label>
          <textarea id="uin-person-note" value={a.note} rows={3} disabled={a.busy}
                    onChange={(e) => a.setNote(e.target.value)} />
          <div className="uin-thread-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={a.busy} onClick={a.save}>Save</button>
            <button type="button" className="uin-chip" disabled={a.busy} onClick={a.closeEditing}>Cancel</button>
          </div>
        </div>
      )}

      {a.canManage && a.merging && (
        <div className="uin-ctx-add uin-ctx-add-stacked">
          <label htmlFor="uin-merge-q">Who is the same person as this one?</label>
          <div className="uin-thread-actions">
            <input id="uin-merge-q" value={a.query} disabled={a.busy} placeholder="Their name or address"
                   onChange={(e) => a.setQuery(e.target.value)}
                   onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); a.search() } }} />
            <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy} onClick={a.search}>Search</button>
          </div>
          <ul className="uin-ctx-list">
            {a.found.map((p) => (
              <li key={p.id} className="uin-ctx-row">
                <div className="uin-ctx-main">
                  <span>{p.name || p.email || 'Somebody'}</span>
                  {p.organisation && <span className="uin-tag">{p.organisation}</span>}
                </div>
                <span className="uin-ctx-sub">{p.email}</span>
                <button type="button" className="uin-chip" disabled={a.busy} onClick={() => a.askMerge(p)}>
                  Merge into this person
                </button>
              </li>
            ))}
            {a.searched && a.found.length === 0 && !a.busy && (
              <li className="uin-ctx-row"><span className="uin-ctx-sub">Nobody else matches that.</span></li>
            )}
          </ul>
        </div>
      )}

      {a.canManage && a.splitting && (
        <div className="uin-ctx-add uin-ctx-add-stacked">
          <p className="uin-ctx-sub">
            Tick the addresses that belong to somebody else. They move to a new person, and so do
            the conversations they were had on.
          </p>
          {a.identities.map((identity) => (
            <label key={identity.id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={a.chosen.includes(identity.id)}
                disabled={a.busy}
                onChange={(e) => a.toggleChosen(identity.id, e.target.checked)}
              />
              {identity.value}
            </label>
          ))}
          {/* Said here rather than found out by pressing the button: moving
              every address leaves a person with nobody in them, and the site
              will not do it. */}
          {everyAddress && (
            <p className="uin-ctx-sub">
              Leave at least one address behind. Moving them all would leave nobody here - rename
              them instead.
            </p>
          )}
          <div className="uin-thread-actions">
            <button type="button" className="btn btn-primary btn-sm"
                    disabled={a.busy || a.chosen.length === 0 || everyAddress} onClick={a.split}>
              Move them out
            </button>
            <button type="button" className="uin-chip" disabled={a.busy} onClick={a.closeSplitting}>Cancel</button>
          </div>
        </div>
      )}

      {a.canManage && a.erasing && a.preview && (
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
            Erasing {a.preview.name || 'this person'} removes, from this inbox only:
          </p>
          <ul style={{ margin: '0 0 0.75rem 1.25rem', padding: 0 }}>
            <li>{a.preview.conversations} conversation{a.preview.conversations === 1 ? '' : 's'}, with {a.preview.messages} message{a.preview.messages === 1 ? '' : 's'}</li>
            <li>{a.preview.attachments} attached file{a.preview.attachments === 1 ? '' : 's'}{a.preview.storedAttachments > 0 ? `, ${a.preview.storedAttachments} of which we are storing a copy of` : ''}</li>
            <li>{a.preview.identities.length} address{a.preview.identities.length === 1 ? '' : 'es'}: {a.preview.identities.join(', ') || 'none on record'}</li>
            <li>Everything we worked out about them - their name, their notes and their organisation</li>
          </ul>
          <p style={{ marginTop: 0, fontWeight: 600 }}>It does NOT remove:</p>
          <ul style={{ margin: '0 0 0.75rem 1.25rem', padding: 0 }}>
            {a.preview.links.length > 0 && (
              <li>
                {a.preview.links.length} record{a.preview.links.length === 1 ? '' : 's'} attached to their
                conversations{recordHomes ? ` (${recordHomes})` : ''}. The
                attachment goes; the record stays where it is.
              </li>
            )}
            <li>Their orders, invoices, quotes, purchase orders or member account. Those belong to the other parts of this site and have their own rules about keeping them.</li>
            {a.preview.outboundLogRows > 0 && (
              <li>
                The site&rsquo;s record that {a.preview.outboundLogRows} automated email{a.preview.outboundLogRows === 1 ? ' was' : 's were'} sent
                to them. That record holds the address and the subject and has never held a copy of what was said.
              </li>
            )}
          </ul>
          <p style={{ marginTop: 0 }}>This cannot be undone.</p>
          <div className="uin-thread-actions">
            <button type="button" className="btn btn-danger btn-sm" disabled={a.busy} onClick={a.askErase}>
              Erase them for good
            </button>
            <button type="button" className="uin-chip" disabled={a.busy} onClick={a.closeErase}>
              Leave it
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!a.mergeCandidate}
        title="Merge them into this person?"
        body={
          a.mergeCandidate
            ? `${mergeLabel} stops being a separate person. Their ${a.mergeCandidate.conversations} conversation${a.mergeCandidate.conversations === 1 ? '' : 's'} and every address they have move across. There is a Put it back button afterwards.`
            : ''
        }
        confirmLabel="Merge them"
        destructive
        busy={a.busy}
        onCancel={a.cancelMerge}
        onConfirm={a.merge}
      />

      <ConfirmDialog
        open={a.eraseAsked}
        title="Erase everything about them?"
        body={
          a.preview
            ? `${a.preview.conversations} conversation${a.preview.conversations === 1 ? '' : 's'}, ${a.preview.messages} message${a.preview.messages === 1 ? '' : 's'} and ${a.preview.attachments} attached file${a.preview.attachments === 1 ? '' : 's'} go for good. Their orders, invoices, quotes and member account are held elsewhere on this site and are not touched.`
            : ''
        }
        confirmLabel="Erase them"
        destructive
        busy={a.busy}
        onCancel={a.cancelErase}
        onConfirm={a.erase}
      />
    </div>
  )
}
