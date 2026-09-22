'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CampaignPulse } from './inbox/campaigns/CampaignPulse'
import { autoCheckSeconds, checkDue, returnCheckSeconds } from '@/modules/unified-inbox/lib/auto-check-pace'
import { isMailViewOpen, onMailViewChange } from '@/modules/unified-inbox/lib/mail-view'

const CONFIG_EVERY_MS = 60_000

// A return that needed no round of its own still redraws the list, but not on
// every alt-tab: at most this often.
const RETURN_REFRESH_SECONDS = 15

// When any admin tab in this browser last started a round, so three tabs left
// open do not check three times as often as one: a tab reading mail keeps the
// Settings pace, and the others see its rounds and stay quiet.
const LAST_CHECK_KEY = 'uin:last-auto-check'

function readSharedLastCheck(): number {
  try {
    const value = Number(window.localStorage.getItem(LAST_CHECK_KEY))
    return Number.isFinite(value) ? value : 0
  } catch {
    return 0
  }
}

function writeSharedLastCheck(at: number): void {
  try {
    window.localStorage.setItem(LAST_CHECK_KEY, String(at))
  } catch {
    // Storage refused (a private window). This tab still keeps its own time.
  }
}

type PulseConfig = {
  autoCheckSeconds: number | null
  hasConnections: boolean
  canCampaign: boolean
  runningCampaigns: number
}

// Keeps mail collection and campaign sending moving while somebody has the
// admin area open - on any screen, and even when the browser tab is behind
// another window. The inbox rail used to host these timers, which meant they
// unmounted the moment somebody opened Settings, and they stopped the moment
// the tab went to the background.
//
// At the Settings pace only while the mail view is on screen in the tab being
// looked at. Everywhere else it slows to the background pace, and it counts
// rounds any other tab started - see lib/auto-check-pace.ts for why.
//
// Renders nothing except the campaign clock when one is due. A successful mail
// check refreshes the current route so an open inbox list picks up what arrived.

export function AdminMailPulse() {
  const router = useRouter()
  const [config, setConfig] = useState<PulseConfig | null>(null)
  const checkRunning = useRef(false)
  const lastCheckAt = useRef(0)
  // When this tab last redrew the list with fresh data, from a round of its own
  // or from catching up on one another tab ran.
  const lastRefreshAt = useRef(0)
  // Focus and visibilitychange usually arrive together for one return.
  const lastReturnAt = useRef(0)
  const configRef = useRef<PulseConfig | null>(null)

  useEffect(() => {
    configRef.current = config
  }, [config])

  /** Resolves true when a round was started (or one is already under way). */
  const runCheck = useCallback(async (returning = false): Promise<boolean> => {
    const cfg = configRef.current
    if (!cfg?.hasConnections || !cfg.autoCheckSeconds) return false
    if (checkRunning.current) return true
    const watching = isMailViewOpen() && document.visibilityState === 'visible'
    const seconds = returning
      ? returnCheckSeconds(cfg.autoCheckSeconds)
      : autoCheckSeconds(cfg.autoCheckSeconds, watching)
    const now = Date.now()
    if (!checkDue(Math.max(lastCheckAt.current, readSharedLastCheck()), seconds, now)) return false
    lastCheckAt.current = now
    writeSharedLastCheck(now)
    checkRunning.current = true
    try {
      const response = await fetch('/api/m/unified-inbox/admin/check-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto: true }),
      })
      if (response.ok) {
        lastRefreshAt.current = Date.now()
        router.refresh()
      }
    } catch {
      // A moment offline is not worth an alert nobody asked for.
    } finally {
      checkRunning.current = false
    }
    return true
  }, [router])

  useEffect(() => {
    let stopped = false

    const refreshConfig = async () => {
      try {
        const response = await fetch('/api/m/unified-inbox/admin/pulse-config', { cache: 'no-store' })
        if (stopped || !response.ok) return
        const body = await response.json() as PulseConfig
        if (typeof body?.hasConnections !== 'boolean') return
        setConfig(body)
        void runCheck()
      } catch {
        // Offline for a moment. The next round tries again.
      }
    }

    void refreshConfig()
    const configTimer = window.setInterval(() => { void refreshConfig() }, CONFIG_EVERY_MS)
    return () => {
      stopped = true
      window.clearInterval(configTimer)
    }
  }, [runCheck])

  // Ticks at the Settings pace everywhere, and runCheck decides whether this
  // tick is due at the pace that applies right now - so opening the mail view,
  // or coming back to the tab, needs no timer rebuilt.
  useEffect(() => {
    if (!config?.autoCheckSeconds) return
    const tick = () => { void runCheck() }
    tick()
    const id = window.setInterval(tick, config.autoCheckSeconds * 1000)
    return () => window.clearInterval(id)
  }, [config?.autoCheckSeconds, config?.hasConnections, runCheck])

  // Somebody arriving at the mail view - from another admin screen, another
  // browser tab or another window - gets a round straight away, whatever the
  // Settings interval says: they have been away from a list that has not moved.
  // See returnCheckSeconds for the short floor that keeps alt-tabbing cheap.
  //
  // When no round is needed because one ran moments ago - quite possibly in
  // another tab, whose refresh only redrew that tab - this one still redraws,
  // so what that round brought in is on the screen being looked at.
  useEffect(() => {
    const catchUp = () => {
      if (document.visibilityState !== 'visible' || !isMailViewOpen()) {
        void runCheck()
        return
      }
      const now = Date.now()
      if (now - lastReturnAt.current < 2_000) return
      lastReturnAt.current = now
      void runCheck(true).then((started) => {
        if (started) return
        if (!checkDue(lastRefreshAt.current, RETURN_REFRESH_SECONDS, Date.now())) return
        lastRefreshAt.current = Date.now()
        router.refresh()
      })
    }
    const stopWatchingView = onMailViewChange(catchUp)
    document.addEventListener('visibilitychange', catchUp)
    window.addEventListener('focus', catchUp)
    return () => {
      stopWatchingView()
      document.removeEventListener('visibilitychange', catchUp)
      window.removeEventListener('focus', catchUp)
    }
  }, [runCheck, router])

  const showCampaignPulse = config?.canCampaign === true && (config?.runningCampaigns ?? 0) > 0

  return showCampaignPulse ? <CampaignPulse /> : null
}
