import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { canReplyToInbox } from '@/modules/unified-inbox/lib/access'
import { restartAudienceFor } from '@/modules/unified-inbox/lib/campaigns/build'
import { getCampaign, resetCampaignForNewRun } from '@/modules/unified-inbox/lib/campaigns/store'
import { CampaignRestartBody } from '@/modules/unified-inbox/lib/validation'

// Send the whole thing again, to everybody.
//
// Only on a campaign that is OVER - finished, or stopped by hand. A running or
// paused campaign has Pause, Resume and Stop, and a "start it over" button
// beside those is a button somebody presses meaning one of the other three.
//
// It comes back as a DRAFT rather than going out, which is the point: the
// second run goes through the same start as the first, with the same readiness
// check and the same warnings, rather than two thousand emails leaving because
// somebody pressed a button on a screen they were only looking at.
//
// See restartAudienceFor for what this destroys and what it keeps. The short of
// it: the previous run's per-message record goes, and nobody's unsubscribe does.
export const maxDuration = 300

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.campaigns')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const campaign = await getCampaign(id)
  if (!campaign) return errorResponse('That campaign is no longer here.', 404)

  if (campaign.status !== 'done' && campaign.status !== 'stopped') {
    return errorResponse(
      'Only a campaign that has finished can be started over. Stop this one first if that is what you want.',
    )
  }
  if (!campaign.inboxId) {
    return errorResponse('The address this sent from has been removed. Choose another one first.')
  }
  if (!await canReplyToInbox(user, campaign.inboxId)) {
    return errorResponse('You cannot send from that address.', 403)
  }

  const parsed = CampaignRestartBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That could not be done.')

  const summary = await restartAudienceFor(campaign, new Date())
  await resetCampaignForNewRun(id)

  return NextResponse.json({ ok: true, summary })
}
