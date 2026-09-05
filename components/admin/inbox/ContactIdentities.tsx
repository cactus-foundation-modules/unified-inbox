'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { channelLabel } from '@/modules/unified-inbox/lib/list'

// Every way we know of reaching one person, and the two things somebody wants
// to do to that list: add the mobile they actually answer, and take off the
// address that turned out to be a colleague's.
//
// Chat identities are shown and never removable here. They are issued by the
// service that owns the chat rather than typed by anybody, and taking one off
// would quietly detach a live conversation from the person having it. The
// remove is offered on the ones a person put there.

type Identity = { id: string; kind: string; value: string; source: string | null }

type Props = {
  personId: string
  identities: Identity[]
  /** Whether this reader may change the list at all. Reading somebody's card
   *  and answering them are different grants. */
  canEdit: boolean
}

export function ContactIdentities({ personId, identities, canEdit }: Props) {
  const router = useRouter()
  const [adding, setAdding] = useState(false)
  const [kind, setKind] = useState<'email' | 'phone'>('email')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const call = async (url: string, init: RequestInit): Promise<boolean> => {
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
  }

  const add = async () => {
    if (!value.trim()) return
    const ok = await call(`/api/m/unified-inbox/people/${personId}/identities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, value: value.trim() }),
    })
    if (ok) { setValue(''); setAdding(false) }
  }

  const remove = async (identityId: string) => {
    await call(`/api/m/unified-inbox/people/${personId}/identities/${identityId}`, {
      method: 'DELETE',
    })
  }

  return (
    <>
      <ul className="uin-ctx-list">
        {identities.map((identity) => (
          <li key={identity.id} className="uin-ctx-row">
            <div className="uin-ctx-main">
              <span>{identity.value}</span>
              {identity.kind !== 'email' && (
                <span className="uin-tag">{channelLabel(identity.kind)}</span>
              )}
            </div>
            {canEdit && identity.kind !== 'chat' && (
              <button
                type="button"
                className="uin-ctx-remove"
                disabled={busy}
                onClick={() => { void remove(identity.id) }}
              >
                <span aria-hidden="true">&times;</span>
                <span className="sr-only">Take {identity.value} off this contact</span>
              </button>
            )}
          </li>
        ))}
        {identities.length === 0 && (
          <li className="uin-ctx-row"><span className="uin-ctx-sub">Nothing on record yet.</span></li>
        )}
      </ul>

      {error && <div className="alert alert-danger" role="alert">{error}</div>}

      {canEdit && (adding ? (
        <div className="uin-ctx-add">
          <label className="sr-only" htmlFor="uin-identity-kind">What kind</label>
          <select
            id="uin-identity-kind"
            value={kind}
            disabled={busy}
            onChange={(event) => setKind(event.target.value === 'phone' ? 'phone' : 'email')}
          >
            <option value="email">Email address</option>
            <option value="phone">Phone number</option>
          </select>
          <label className="sr-only" htmlFor="uin-identity-value">The address or number</label>
          <input
            id="uin-identity-value"
            value={value}
            disabled={busy}
            autoFocus
            placeholder={kind === 'email' ? 'name@example.com' : '01234 567890'}
            onChange={(event) => setValue(event.target.value)}
          />
          <div className="uin-ctx-add-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => { void add() }}>
              Add
            </button>
            <button type="button" className="uin-chip" disabled={busy} onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="uin-field-add" onClick={() => setAdding(true)}>
          Add another way of reaching them
        </button>
      ))}
    </>
  )
}
