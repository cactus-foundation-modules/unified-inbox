'use client'

import { useState } from 'react'
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

const KINDS: Array<{ id: 'order' | 'po' | 'quote'; label: string }> = [
  { id: 'order', label: 'Order' },
  { id: 'po', label: 'Purchase order' },
  { id: 'quote', label: 'Quote' },
]

export function AddLink({ threadId }: { threadId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<'order' | 'po' | 'quote'>('order')
  const [reference, setReference] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function add() {
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
      setReference('')
      setOpen(false)
      router.refresh()
    } catch {
      setError('The site could not be reached, so nothing changed.')
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button type="button" className="uin-chip" onClick={() => setOpen(true)}>
        Attach something
      </button>
    )
  }

  return (
    <div className="uin-ctx-add">
      <label className="sr-only" htmlFor="uin-link-kind">What kind of record</label>
      <select id="uin-link-kind" value={kind} disabled={busy}
              onChange={(e) => setKind(e.target.value as 'order' | 'po' | 'quote')}>
        {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
      </select>
      <label className="sr-only" htmlFor="uin-link-ref">Its reference</label>
      <input
        id="uin-link-ref"
        value={reference}
        disabled={busy}
        placeholder="Its number"
        onChange={(e) => setReference(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add() } }}
      />
      <button type="button" className="btn btn-primary btn-sm" disabled={busy || !reference.trim()} onClick={add}>
        Attach
      </button>
      <button type="button" className="uin-chip" disabled={busy} onClick={() => { setOpen(false); setError('') }}>
        Cancel
      </button>
      {error && <div className="alert alert-danger">{error}</div>}
    </div>
  )
}
