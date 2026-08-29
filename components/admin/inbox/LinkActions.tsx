'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

// Taking a link off, and putting one on by hand.
//
// The first of these is what makes automatic linking acceptable at all: every
// link we worked out ourselves says so on its face and comes off in one click.
// A guess nobody can see and nobody can undo is not a guess worth making on
// somebody else's behalf.

export function LinkActions({ linkId, label }: { linkId: string; label: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function remove() {
    setBusy(true)
    try {
      await fetch(`/api/m/unified-inbox/links/${linkId}`, { method: 'DELETE' })
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      className="uin-ctx-remove"
      disabled={busy}
      onClick={remove}
      aria-label={`Take ${label} off this conversation`}
      title="Take this off"
    >
      Remove
    </button>
  )
}

export type LinkKindChoice = { id: 'order' | 'po' | 'quote'; label: string }

type Suggestion = {
  reference: string
  label: string
  detail: string | null
  status: string | null
}

/**
 * Putting a record on a conversation.
 *
 * Typing the number was the whole of this to begin with, and it assumed
 * somebody had the number. The supplier answering a purchase order does not
 * quote it, the customer asking where their desk is quotes it wrong, and the
 * person reading the message has the other screen open in another tab either
 * way. So the list comes to them: open it and the records that are plausibly
 * this conversation's are already there, theirs first, with typing narrowing it
 * rather than being the only way in.
 *
 * Which kind it opens on is decided on the server from what the inbox is used
 * for, so purchasing's address offers purchase orders and the shop's offers
 * orders without anybody choosing twice.
 */
export function AddLink({
  threadId, kinds, defaultKind,
}: {
  threadId: string
  kinds: LinkKindChoice[]
  defaultKind: 'order' | 'po' | 'quote' | null
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<'order' | 'po' | 'quote'>(defaultKind ?? kinds[0]?.id ?? 'order')
  const [term, setTerm] = useState('')
  const [results, setResults] = useState<Suggestion[]>([])
  const [searching, setSearching] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Every search that comes back is checked against the one being waited for.
  // Two keystrokes in flight at once come back in whichever order the database
  // felt like, and the older one landing last shows the wrong list.
  const request = useRef(0)

  useEffect(() => {
    if (!open) return
    const mine = ++request.current
    const timer = setTimeout(() => {
      setSearching(true)
      const url = `/api/m/unified-inbox/threads/${threadId}/links`
        + `?kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(term.trim())}`
      fetch(url)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('no'))))
        .then((data: { records?: Suggestion[] }) => {
          if (mine !== request.current) return
          setResults(Array.isArray(data.records) ? data.records : [])
        })
        .catch(() => { if (mine === request.current) setResults([]) })
        .finally(() => { if (mine === request.current) setSearching(false) })
      // Long enough that typing a six-figure order number is one search rather
      // than six, short enough that it feels like the list is keeping up.
    }, term.trim() ? 250 : 0)
    return () => clearTimeout(timer)
  }, [open, kind, term, threadId])

  async function attach(reference: string) {
    if (!reference.trim()) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/m/unified-inbox/threads/${threadId}/links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, reference }),
      })
      if (!response.ok) {
        setError((await response.json().catch(() => null))?.error ?? 'That did not attach.')
        return
      }
      setTerm('')
      setOpen(false)
      router.refresh()
    } catch {
      setError('The site could not be reached, so nothing changed.')
    } finally {
      setBusy(false)
    }
  }

  // Nothing on this site keeps records anybody attaches by hand - no shop, no
  // purchasing, or no permission to see either. An invitation to attach
  // something that could only ever answer "nothing has that number" is worse
  // than no invitation.
  if (kinds.length === 0) return null

  if (!open) {
    return (
      <button type="button" className="uin-chip"
              onClick={() => { setSearching(true); setOpen(true) }}>
        Attach something
      </button>
    )
  }

  const typed = term.trim()

  return (
    <div className="uin-ctx-add">
      {kinds.length > 1 && (
        <>
          <label className="sr-only" htmlFor="uin-link-kind">What kind of record</label>
          <select id="uin-link-kind" value={kind} disabled={busy}
                  onChange={(e) => {
                    setKind(e.target.value as 'order' | 'po' | 'quote')
                    setResults([])
                    setSearching(true)
                    setError('')
                  }}>
            {kinds.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
        </>
      )}
      <label className="sr-only" htmlFor="uin-link-ref">
        Search {kinds.find((k) => k.id === kind)?.label.toLowerCase() ?? 'records'}
      </label>
      <input
        id="uin-link-ref"
        value={term}
        disabled={busy}
        placeholder="Number, name or address"
        onChange={(e) => { setTerm(e.target.value); setSearching(true) }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void attach(typed) } }}
      />

      {results.length > 0 ? (
        <ul className="uin-ctx-picker">
          {results.map((r) => (
            <li key={r.reference}>
              <button type="button" disabled={busy} onClick={() => attach(r.reference)}>
                <span className="uin-ctx-main">
                  <span>{r.label}</span>
                  {r.status && <span className="uin-tag">{r.status}</span>}
                </span>
                {r.detail && <span className="uin-ctx-sub">{r.detail}</span>}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="uin-ctx-sub">
          {searching
            ? 'Looking...'
            : typed
              ? 'Nothing here matches that. Attach it by its number if you know it is right.'
              : 'Nothing to choose from yet.'}
        </p>
      )}

      <div className="uin-ctx-add-actions">
        {typed && (
          <button type="button" className="btn btn-primary btn-sm" disabled={busy}
                  onClick={() => attach(typed)}>
            Attach {typed}
          </button>
        )}
        <button type="button" className="uin-chip" disabled={busy}
                onClick={() => { setOpen(false); setError(''); setTerm('') }}>
          Cancel
        </button>
      </div>
      {error && <div className="alert alert-danger">{error}</div>}
    </div>
  )
}
