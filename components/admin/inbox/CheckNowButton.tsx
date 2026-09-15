'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { RefreshIcon } from './icons'

// Fetch whatever has arrived since the last round, now, rather than waiting for
// the hourly one.
//
// Same engine and same route as the Check now button in Settings, with no
// account named, so it collects from every mail account at once - which is what
// somebody standing in front of the list means by refreshing it. An account
// checked in the last few seconds is stepped over rather than opened again, and
// the route says so in plain English instead of refusing - a press is always
// answered, and the list always refreshes on the back of it.
//
// Only offered where it can actually do something: it takes the manage
// permission and there has to be a mail account to check. A button whose only
// possible answer is "you do not have permission" is worse than no button.
//
// Automatic checks while the admin area is open live in AdminMailPulse instead,
// so they keep running on every admin screen and in background tabs.

export type CheckNowNotice = { tone: 'ok' | 'bad'; text: string }

type Props = {
  /** Where the outcome goes. The row this sits in owns the space for it: an
   *  alert inside a strip of tabs would take the row apart. */
  onResult: (notice: CheckNowNotice | null) => void
  /** When a check came back having actually opened the accounts, so the line
   *  beside this button can say when the mail was last collected. */
  onChecked: (at: number) => void
}

export function CheckNowButton({ onResult, onChecked }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  const check = useCallback(async () => {
    setBusy(true)
    onResult(null)
    try {
      const response = await fetch('/api/m/unified-inbox/admin/check-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto: false }),
      })
      const body = await response.json().catch(() => null)
      if (response.ok) {
        onChecked(Date.now())
        onResult({ tone: 'ok', text: body?.message ?? 'Checked.' })
        router.refresh()
      } else {
        onResult({ tone: 'bad', text: body?.error ?? 'That did not work.' })
      }
    } catch {
      onResult({ tone: 'bad', text: 'The site could not be reached, so nothing was collected.' })
    } finally {
      setBusy(false)
    }
  }, [onResult, onChecked, router])

  const latest = useRef(check)
  useEffect(() => { latest.current = check }, [check])

  const lastRunAt = useRef(0)

  return (
    <button
      type="button"
      className="uin-refresh"
      data-busy={busy ? '1' : undefined}
      disabled={busy}
      onClick={() => { lastRunAt.current = Date.now(); void check() }}
      title="Fetch new mail now"
      aria-label={busy ? 'Fetching new mail' : 'Fetch new mail now'}
    >
      {RefreshIcon}
    </button>
  )
}
