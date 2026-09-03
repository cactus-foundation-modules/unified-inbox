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
// The same check can also run on its own while somebody is watching the list -
// see `autoSeconds`. That is a browser timer rather than a second scheduled
// job: it costs nothing when nobody is looking, and it stops the moment the
// page is closed or the tab goes behind something else.

export type CheckNowNotice = { tone: 'ok' | 'bad'; text: string }

type Props = {
  /** Where the outcome goes. The row this sits in owns the space for it: an
   *  alert inside a strip of tabs would take the row apart. */
  onResult: (notice: CheckNowNotice | null) => void
  /** Seconds between checks that run on their own while this page is open and
   *  in front of somebody, or null for none. Never below the route's minute of
   *  cooldown - the settings screen will not offer it and the route would
   *  refuse it anyway. */
  autoSeconds: number | null
}

export function CheckNowButton({ onResult, autoSeconds }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  const check = useCallback(async (quiet = false) => {
    setBusy(true)
    if (!quiet) onResult(null)
    try {
      const response = await fetch('/api/m/unified-inbox/admin/check-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Rounds the page runs on its own rest an account for a minute; a
        // press rests it for seconds. Somebody who has just pressed the button
        // is asking, and the answer to a question is not "you asked recently".
        body: JSON.stringify({ auto: quiet }),
      })
      const body = await response.json().catch(() => null)
      if (response.ok) {
        // A check nobody asked for says nothing at all, even when it collected
        // something. New mail announcing itself in a strip across the top of
        // the list is a notice about a thing that is already on screen,
        // underneath it, in bold - and it lands while somebody is reading
        // something else. The list refreshing IS the answer.
        if (!quiet) onResult({ tone: 'ok', text: body?.message ?? 'Checked.' })
        // Whatever it collected belongs in the list already on screen.
        router.refresh()
      } else if (!quiet) {
        onResult({ tone: 'bad', text: body?.error ?? 'That did not work.' })
      }
    } catch {
      // Same silence for a check that ran on its own: a moment offline is not
      // worth an alert somebody did not ask for, and the next round tries again.
      if (!quiet) onResult({ tone: 'bad', text: 'The site could not be reached, so nothing was collected.' })
    } finally {
      // In a finally, so a check that never comes back does not leave the button
      // spinning for the rest of the visit.
      setBusy(false)
    }
  }, [onResult, router])

  // Held in a ref so the timer below can call the current one without being
  // torn down and rebuilt - a re-created interval never reaches the end of its
  // wait, and the checking would silently never happen.
  const latest = useRef(check)
  const running = useRef(false)
  // Written in an effect rather than during render, which is where React wants
  // a ref touched at all.
  useEffect(() => {
    latest.current = check
    running.current = busy
  }, [check, busy])

  // When the last check was started, by any route into this button. A tab
  // coming back to the front asks against this rather than against the clock it
  // was not watching, so it does not spend a function call being told about a
  // cooldown it could have worked out for itself.
  const lastRunAt = useRef(0)

  useEffect(() => {
    if (!autoSeconds) return
    const tick = () => {
      // Nothing in a tab behind another window: whoever set this wanted the
      // list in front of them kept fresh, not every tab they have ever left
      // open holding a mailbox connection at the far end.
      if (document.visibilityState !== 'visible') return
      // And nothing on top of a check already in flight. The route holds a lock
      // per account and would turn it away, but the second request still costs
      // the site a function call to be told so.
      if (running.current) return
      if (Date.now() - lastRunAt.current < autoSeconds * 1000) return
      lastRunAt.current = Date.now()
      void latest.current(true)
    }
    const id = window.setInterval(tick, autoSeconds * 1000)
    // A tab coming back to the front has been still for however long it was
    // hidden, so it asks once on the way in rather than waiting out the rest of
    // an interval that ran through with nothing to do.
    const onVisible = () => { if (document.visibilityState === 'visible') tick() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [autoSeconds])

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
