'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// A message that failed to leave, having another go. It reuses the same row and
// the same Message-ID, so this is one message trying again rather than a second
// one saying the same thing.

export function RetryButton({ messageId }: { messageId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  return (
    <>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError('')
          try {
            const response = await fetch(`/api/m/unified-inbox/messages/${messageId}/retry`, { method: 'POST' })
            if (!response.ok) {
              setError((await response.json().catch(() => null))?.error ?? 'It would not go that time either.')
              return
            }
            router.refresh()
          } catch {
            setError('The site could not be reached.')
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? 'Trying again...' : 'Try again'}
      </button>
      {error && <span style={{ color: 'var(--color-danger)' }}>{error}</span>}
    </>
  )
}
