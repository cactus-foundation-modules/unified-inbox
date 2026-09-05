import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getSiteTimezone } from '@/lib/config/timezone.server'
import { buildAudienceFor, previewAudienceFor, topUpAudienceFor } from '@/modules/unified-inbox/lib/campaigns/build'
import { campaignTally, getCampaign } from '@/modules/unified-inbox/lib/campaigns/store'
import { forecastFinish, nextSlot } from '@/modules/unified-inbox/lib/campaigns/window'
import { CampaignAudienceBody } from '@/modules/unified-inbox/lib/validation'

// Who it goes to.
//
// GET is the question - how many would this be, and who would be left out and
// why - answered without writing anything down, so the Who step can show a
// count that changes as somebody ticks categories.
//
// POST is the answer written down. Rebuilding is only allowed while nothing has
// been sent: clearing the list under a running campaign would throw away the
// record of who had already had it and start writing to them again. Once it is
// running, Top up is the way in - it adds the people who have appeared since
// and leaves everybody already on it exactly as they are, unsubscribes
// included.
export const maxDuration = 300

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.campaigns')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const campaign = await getCampaign(id)
  if (!campaign) return errorResponse('That campaign is no longer here.', 404)

  const summary = await previewAudienceFor(campaign)
  const timezone = await getSiteTimezone()

  return NextResponse.json({
    ok: true,
    summary,
    // What that many actually means in days, which is the thing somebody wants
    // to know before they commit to it.
    finishesAbout: summary.included > 0
      ? forecastFinish(summary.included, campaign.window, timezone, new Date())
      : null,
    firstGoesAt: nextSlot(campaign.startAt ?? new Date(), campaign.window, timezone),
  })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.campaigns')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const campaign = await getCampaign(id)
  if (!campaign) return errorResponse('That campaign is no longer here.', 404)

  const parsed = CampaignAudienceBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That could not be done.')

  const tally = await campaignTally(id)
  const hasSent = tally.done + tally.replied + tally.bounced + tally.failed + tally.unsubscribed > 0

  if (parsed.data.mode === 'rebuild') {
    if (campaign.status === 'running') {
      return errorResponse('Pause it before rebuilding the list.')
    }
    if (hasSent) {
      return errorResponse(
        'Some of this has already gone out, so the list cannot be built again from scratch - '
        + 'that would lose the record of who has had it. Use Top up to add anybody new.',
      )
    }
    const summary = await buildAudienceFor(campaign, campaign.startAt ?? new Date())
    return NextResponse.json({ ok: true, summary })
  }

  const summary = await topUpAudienceFor(campaign, campaign.startAt ?? new Date())
  return NextResponse.json({ ok: true, summary })
}
