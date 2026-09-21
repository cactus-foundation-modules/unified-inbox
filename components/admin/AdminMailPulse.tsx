'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CampaignPulse } from './inbox/campaigns/CampaignPulse'
import { autoCheckSeconds, checkDue } from '@/modules/unified-inbox/lib/auto-check-pace'
import { isMailViewOpen, onMailViewChange } from '@/modules/unified-inbox/lib/mail-view'

const CONFIG_EVERY_MS = 60_000

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
  const configRef = useRef<PulseConfig | null>(null)

  useEffect(() => {
    configRef.current = config
  }, [config])

  const runCheck = useCallback(async () => {
    const cfg = configRef.current
    if (!cfg?.hasConnections || !cfg.autoCheckSeconds) return
    if (checkRunning.current) return
    const watching = isMailViewOpen() && document.visibilityState === 'visible'
    const seconds = autoCheckSeconds(cfg.autoCheckSeconds, watching)
    const now = Date.now()
    if (!checkDue(Math.max(lastCheckAt.current, readSharedLastCheck()), seconds, now)) return
    lastCheckAt.current = now
    writeSharedLastCheck(now)
    checkRunning.current = true
    try {
      const response = await fetch('/api/m/unified-inbox/admin/check-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto: true }),
      })
      if (response.ok) router.refresh()
    } catch {
      // A moment offline is not worth an alert nobody asked for.
    } finally {
      checkRunning.current = false
    }
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

  // Somebody arriving at the mail view, or bringing the tab back to the front,
  // gets a round straight away if the faster pace says one is due, rather than
  // waiting out whatever is left of a background interval.
  useEffect(() => {
    const catchUp = () => { void runCheck() }
    const stopWatchingView = onMailViewChange(catchUp)
    document.addEventListener('visibilitychange', catchUp)
    return () => {
      stopWatchingView()
      document.removeEventListener('visibilitychange', catchUp)
    }
  }, [runCheck])

  const showCampaignPulse = config?.canCampaign === true && (config?.runningCampaigns ?? 0) > 0

  return showCampaignPulse ? <CampaignPulse /> : null
}
