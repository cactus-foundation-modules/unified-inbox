'use client'

import { useEffect } from 'react'
import { campaignApi } from './api'

// The clock that keeps campaigns moving while somebody has the inbox open -
// ANY of it, not only the Campaigns screen.
//
// A campaign's pace is the pace of whatever asks it to send the next one, and
// on most hosting the site's own scheduled round comes past every five minutes
// at best and once an hour at worst. That is the right answer for a chase due
// on Thursday and useless for one message every ninety seconds. This used to
// live on the Campaigns screen alone, which meant a campaign only really moved
// while somebody stood and watched the one screen nobody has any reason to
// stand and watch - so it now rides with the rail, on every inbox screen there
// is, and reading the post keeps the post going out.
//
// It is safe to ask as often as it likes. The gap between messages lives in the
// database on the sending address's own lane, and a tick arriving before the
// moment has come sends nothing at all - so this cannot make a campaign go
// faster than it was set to, only stop it going slower.
//
// It stops when the tab goes to the background, because a laptop lid closing
// should not leave a page quietly poking the server for a fortnight, and
// because a browser throttles the timer to death anyway.
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
    // Two ticks in flight at once would be two runs of the engine, which the
    // lane claim survives but need not be asked to: a run taking longer than
    // the gap simply skips the tick it overlapped.
    let inFlight = false

    const tick = async () => {
      if (stopped || inFlight || document.visibilityState !== 'visible') return
      inFlight = true
      try {
        const result = await campaignApi.tick()
        if (stopped || !result.ok) return
        const { sent, failed, replied } = result.data
        if (sent === 0 && failed === 0 && replied === 0) return
        window.dispatchEvent(
          new CustomEvent<CampaignTickDetail>(CAMPAIGN_TICK_EVENT, { detail: { sent, failed, replied } })
        )
      } finally {
        inFlight = false
      }
    }

    // Once straight away, so opening the inbox on a campaign that is due does
    // not sit there for half a minute doing nothing.
    void tick()
    const timer = setInterval(() => { void tick() }, EVERY_MS)
    // A tab coming back to the front has missed every tick it was away for, and
    // the first thing its owner wants is the campaign caught up rather than
    // waiting out the rest of the interval.
    const onVisible = () => { if (document.visibilityState === 'visible') void tick() }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      stopped = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return null
}
