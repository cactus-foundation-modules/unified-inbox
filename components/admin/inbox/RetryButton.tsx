'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// A message that failed to leave, having another go. It reuses the same row and
// the same Message-ID, so this is one message trying again rather than a second
// one saying the same thing.
//
// What comes back when it will not go is never put on the page. The refusal
// carries the transport's own words with it - whatever the mail server said,
// verbatim - and that is written for whoever runs one. What a site owner needs
// is which of the handful of things went wrong and what to do about it, so the
// answer is chosen from the sentences below by the kind of refusal it was, and
// the words that came back are read by nobody.

function refusal(status: number): string {
  if (status === 401) return 'You have been signed out. Sign in again and it will still be here.'
  if (status === 403) return 'You are not allowed to send from that address.'
  if (status === 404) return 'That message is not here any more.'
  return 'It would not go that time either. Check the address is right, or give it a minute and try once more.'
}

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
              setError(refusal(response.status))
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
      {/* A plain span so a whole sentence wraps and can be read. The badge beside
          it does not wrap, by design, and a sentence in one is a sentence cut
          off. The colour is the darker end of the destructive ramp rather than
          --color-danger, which measures under AA on this ground at this size -
          the same reason the failed-send badge uses it. */}
      {error && (
        <span style={{ color: 'var(--color-destructive-hover)' }} role="alert">{error}</span>
      )}
    </>
  )
}
