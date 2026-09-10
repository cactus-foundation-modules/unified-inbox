'use client'

import { useEffect, useState } from 'react'
import { CAMPAIGN_TICK_EVENT, type CampaignTickDetail } from './CampaignPulse'

// What the clock has just done, said out loud on the screen that cares.
//
// The clock itself is CampaignPulse, which rides with the rail on every inbox
// screen - so a campaign moves while somebody reads their post, not only while
// somebody watches the Campaigns list. This used to keep its own timer as well,
// which on this one screen meant two ticks where one would do; it now listens
// to the one that is already running and reloads the list when something has
// actually gone out.

export function CampaignTicker({ onTick }: { onTick: () => void }) {
  const [last, setLast] = useState<{ sent: number; failed: number } | null>(null)

  useEffect(() => {
    const onCampaignTick = (event: Event) => {
      const detail = (event as CustomEvent<CampaignTickDetail>).detail
      if (!detail) return
      setLast({ sent: detail.sent, failed: detail.failed })
      onTick()
    }
    window.addEventListener(CAMPAIGN_TICK_EVENT, onCampaignTick)
    return () => window.removeEventListener(CAMPAIGN_TICK_EVENT, onCampaignTick)
    // The loader handed in is a useCallback with no changing dependencies, so
    // this subscribes once rather than tearing down on every render.
  }, [onTick])

  if (!last) return null

  return (
    <div className="uin-camp-clock" role="status">
      Sent {last.sent === 1 ? 'one' : last.sent} just now while you have been watching.
      {last.failed > 0 && ` ${last.failed} did not go.`}
    </div>
  )
}
