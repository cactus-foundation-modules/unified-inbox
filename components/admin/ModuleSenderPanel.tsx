'use client'

import { useEffect, useState } from 'react'

// ---------------------------------------------------------------------------
// The box another module's settings tab shows: which of your inboxes that
// module's automatic emails go out as.
//
// It renders on Purchase Orders' settings and on the shop's, but it belongs to
// this module - core drops it into a slot those tabs publish, and neither of
// them knows anything about it beyond leaving the space (see
// lib/modules/hosted-settings.ts). Take this module away and the box goes with
// it, leaving no gap and no setting behind.
//
// Saves itself the moment you choose, rather than waiting on the host's own
// Save button, which would not save it: a button that appears to cover a box it
// does not is worse than no button at all.
// ---------------------------------------------------------------------------

const API = '/api/m/unified-inbox/admin/module-senders'

const MUTED: React.CSSProperties = { color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }

const CARD: React.CSSProperties = {
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--color-surface)',
  padding: '1rem',
  marginBottom: '1rem',
  maxWidth: 640,
}

type InboxOption = { id: string; name: string; address: string }

export type ModuleSenderPanelProps = {
  /** The module whose mail this box is about, as its manifest spells it. */
  moduleName: string
  /** What the emails in question are, in the host's own words - "your purchase
   *  orders", "your order confirmations". Written into the sentence, so it has
   *  to read as the object of "send ... from". */
  what: string
}

export function ModuleSenderPanel({ moduleName, what }: ModuleSenderPanelProps) {
  const [inboxes, setInboxes] = useState<InboxOption[] | null>(null)
  const [inboxId, setInboxId] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  // Nothing at all is drawn when the person looking may not manage the inbox,
  // or when this module's tables are not there yet. A box that only ever says
  // "forbidden" on somebody else's settings page is pure noise.
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    let live = true
    fetch(`${API}?module=${encodeURIComponent(moduleName)}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!live) return
        if (!res.ok) { setHidden(true); return }
        const data = await res.json()
        setInboxes(data.inboxes ?? [])
        setInboxId(data.inboxId ?? '')
      })
      .catch(() => { if (live) setHidden(true) })
    return () => { live = false }
  }, [moduleName])

  async function choose(next: string) {
    setInboxId(next)
    setSaving(true)
    setStatus('')
    setError('')
    try {
      const res = await fetch(API, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ module: moduleName, inboxId: next || null }),
      })
      if (res.ok) {
        setStatus('Saved.')
      } else {
        const data = await res.json().catch(() => null)
        setError(data?.error ?? 'That did not save. Try again.')
      }
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  if (hidden || !inboxes) return null

  return (
    <div style={CARD}>
      <h3 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-base)' }}>Which inbox this comes from</h3>

      {inboxes.length === 0 ? (
        <p style={{ ...MUTED, margin: 0 }}>
          You have not set up any inboxes yet. Add one under Settings, Unified Inbox, and this address can be
          the one {what} go out as.
        </p>
      ) : (
        <>
          <div className="field">
            <label htmlFor={`uin-sender-${moduleName}`}>Send {what} from</label>
            <select
              id={`uin-sender-${moduleName}`}
              value={inboxId}
              disabled={saving}
              onChange={(e) => choose(e.target.value)}
            >
              <option value="">The site&rsquo;s usual address</option>
              {inboxes.map((inbox) => (
                <option key={inbox.id} value={inbox.id}>
                  {inbox.name} ({inbox.address})
                </option>
              ))}
            </select>
            <span className="field-hint">
              Pick one of your inboxes and {what} leave as that address, under its own name - and the replies come
              back to it, in the same conversation as everything else that person has written to you. Left as the
              site&rsquo;s usual address, nothing changes.
            </span>
          </div>
          {status && <p style={{ ...MUTED, margin: 0, color: 'var(--color-success)' }}>{status}</p>}
          {error && <p style={{ margin: 0, color: 'var(--color-danger)', fontSize: 'var(--text-sm)' }}>{error}</p>}
        </>
      )}
    </div>
  )
}

// The two hosted panels, one per settings tab that publishes a slot for us.
// Core looks a hosted panel up by its manifest tab id, so each needs its own
// export - and each says, in that module's own language, what the emails are.

export function PurchaseOrdersSenderPanel() {
  return <ModuleSenderPanel moduleName="purchase-orders" what="your purchase order emails" />
}

export function ShopSenderPanel() {
  return <ModuleSenderPanel moduleName="shop" what="your order emails" />
}
