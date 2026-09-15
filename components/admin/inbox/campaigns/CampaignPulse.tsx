'use client'

import { useEffect } from 'react'
import { campaignApi } from './api'

// The clock that keeps campaigns moving while somebody has the admin area open.
//
// A campaign's pace is the pace of whatever asks it to send the next one, and
// on most hosting the site's own scheduled round comes past every five minutes
// at best and once an hour at worst. That is the right answer for a chase due
// on Thursday and useless for one message every ninety seconds. This rides with
// AdminMailPulse on every admin screen, so reading the post - or editing a page
// beside it - keeps the post going out.
//
// It is safe to ask as often as it likes. The gap between messages lives in the
// database on the sending address's own lane, and a tick arriving before the
// moment has come sends nothing at all - so this cannot make a campaign go
// faster than it was set to, only stop it going slower.
//
// It renders nothing. What it sends is announced on the window instead, so the
// Campaigns screen can say so and reload its list without a second clock of its
// own - two clocks would be two ticks, and the second one is pure cost.

const EVERY_MS = 30_000

export const CAMPAIGN_TICK_EVENT = 'uin:campaign-tick'

export type CampaignTickDetail = { sent: number; failed: number; replied: number }

export function CampaignPulse() {
  useEffect(() => {
    let stopped = false
    let inFlight = false

    const tick = async () => {
      if (stopped || inFlight) return
      inFlight = true
      try {
        const result = await campaignApi.tick()
        if (stopped || !result.ok) return
        const { sent, failed, replied } = result.data
        if (sent === 0 && failed === 0 && replied === 0) return
        window.dispatchEvent(
          new CustomEvent<CampaignTickDetail>(CAMPAIGN_TICK_EVENT, { detail: { sent, failed, replied } }),
        )
      } finally {
        inFlight = false
      }
    }

    void tick()
    const timer = setInterval(() => { void tick() }, EVERY_MS)

    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [])

  return null
}
