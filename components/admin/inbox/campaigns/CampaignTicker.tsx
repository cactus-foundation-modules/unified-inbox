'use client'

import { useEffect, useState } from 'react'
import { campaignApi } from './api'

// The clock, while somebody has the screen open.
//
// A campaign's pace is the pace of whatever asks it to send the next one, and
// on most hosting the site's own scheduled round comes past once an hour. That
// is the right answer for a chase due on Thursday and useless for one message
// every ninety seconds - so while this tab is open and in front of somebody,
// this asks every half minute.
//
// It is safe to ask as often as it likes. The gap between messages lives in the
// database on the sending address's own lane, and a tick that arrives before
// the moment has come sends nothing at all - so this cannot make a campaign go
// faster than it was set to, only stop it going slower.
//
// It stops when the tab goes to the background, because a laptop lid closing
// should not leave a page quietly poking the server for a fortnight, and
// because a browser throttles the timer to death anyway.

const EVERY_MS = 30_000

export function CampaignTicker({ onTick }: { onTick: () => void }) {
  const [last, setLast] = useState<{ sent: number; failed: number } | null>(null)

  useEffect(() => {
    let stopped = false

    const tick = async () => {
      if (stopped || document.visibilityState !== 'visible') return
      const result = await campaignApi.tick()
      if (stopped || !result.ok) return
      if (result.data.sent > 0 || result.data.failed > 0 || result.data.replied > 0) {
        setLast({ sent: result.data.sent, failed: result.data.failed })
        onTick()
      }
    }

    // Once straight away, so opening the screen on a campaign that is due does
    // not sit there for half a minute doing nothing.
    void tick()
    const timer = setInterval(() => { void tick() }, EVERY_MS)
    return () => { stopped = true; clearInterval(timer) }
    // The loader handed in is a useCallback with no changing dependencies, so
    // this sets the timer up once rather than tearing it down on every render.
  }, [onTick])

  if (!last) return null

  return (
    <div className="uin-camp-clock" role="status">
      Sent {last.sent === 1 ? 'one' : last.sent} just now while you have been watching.
      {last.failed > 0 && ` ${last.failed} did not go.`}
    </div>
  )
}
