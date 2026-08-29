'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { RefreshIcon } from './icons'

// Fetch whatever has arrived since the last round, now, rather than waiting for
// the hourly one.
//
// Same engine and same route as the Check now button in Settings, with no
// account named, so it collects from every mail account at once - which is what
// somebody standing in front of the list means by refreshing it. The route
// keeps a minute's cooldown of its own and turns a second press away in plain
// English, so its answer is worth showing rather than swallowing.
//
// Only offered where it can actually do something: it takes the manage
// permission and there has to be a mail account to check. A button whose only
// possible answer is "you do not have permission" is worse than no button.

export type CheckNowNotice = { tone: 'ok' | 'bad'; text: string }

type Props = {
  /** Where the outcome goes. The row this sits in owns the space for it: an
   *  alert inside a strip of tabs would take the row apart. */
  onResult: (notice: CheckNowNotice | null) => void
}

export function CheckNowButton({ onResult }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  const check = useCallback(async () => {
    setBusy(true)
    onResult(null)
    try {
      const response = await fetch('/api/m/unified-inbox/admin/check-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const body = await response.json().catch(() => null)
      if (response.ok) {
        onResult({ tone: 'ok', text: body?.message ?? 'Checked.' })
        // Whatever it collected belongs in the list already on screen.
        router.refresh()
      } else {
        onResult({ tone: 'bad', text: body?.error ?? 'That did not work.' })
      }
    } catch {
      onResult({ tone: 'bad', text: 'The site could not be reached, so nothing was collected.' })
    } finally {
      // In a finally, so a check that never comes back does not leave the button
      // spinning for the rest of the visit.
      setBusy(false)
    }
  }, [onResult, router])

  return (
    <button
      type="button"
      className="uin-refresh"
      data-busy={busy ? '1' : undefined}
      disabled={busy}
      onClick={() => void check()}
      title="Fetch new mail now"
      aria-label={busy ? 'Fetching new mail' : 'Fetch new mail now'}
    >
      {RefreshIcon}
    </button>
  )
}
