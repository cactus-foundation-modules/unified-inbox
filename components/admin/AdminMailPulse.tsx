'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CampaignPulse } from './inbox/campaigns/CampaignPulse'

const CONFIG_EVERY_MS = 60_000

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
    if (Date.now() - lastCheckAt.current < cfg.autoCheckSeconds * 1000) return
    lastCheckAt.current = Date.now()
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

  useEffect(() => {
    if (!config?.autoCheckSeconds) return
    const tick = () => { void runCheck() }
    tick()
    const id = window.setInterval(tick, config.autoCheckSeconds * 1000)
    return () => window.clearInterval(id)
  }, [config?.autoCheckSeconds, config?.hasConnections, runCheck])

  const showCampaignPulse = config?.canCampaign === true && (config?.runningCampaigns ?? 0) > 0

  return showCampaignPulse ? <CampaignPulse /> : null
}
