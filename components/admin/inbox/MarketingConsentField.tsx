'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

// What somebody said about marketing email, and where they said it.
//
// The answer and its trail are drawn by the server (PersonView); this is only
// the box a member of staff changes it with when somebody tells them directly.
// Changing it records a new answer dated now, with who changed it - it never
// rewrites the old one's history.

type Props = {
  personId: string
  consent: boolean | null
}

export function MarketingConsentField({ personId, consent }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const change = async (next: string) => {
    if (next !== 'yes' && next !== 'no') return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/m/unified-inbox/people/${personId}/marketing-consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consent: next === 'yes' }),
      })
      if (!response.ok) {
        setError((await response.json().catch(() => null))?.error ?? 'That did not work.')
        return
      }
      router.refresh()
    } catch {
      setError('The site could not be reached, so nothing changed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="uin-ctx-add">
      <label className="sr-only" htmlFor="uin-marketing-consent">Change their answer</label>
      <select
        id="uin-marketing-consent"
        value={consent === true ? 'yes' : consent === false ? 'no' : ''}
        disabled={busy}
        onChange={(event) => void change(event.target.value)}
      >
        {consent === null && <option value="">Not asked - change it…</option>}
        <option value="yes">Happy to receive them</option>
        <option value="no">Asked not to receive them</option>
      </select>
      {error && <div className="alert alert-danger" role="alert">{error}</div>}
    </div>
  )
}
