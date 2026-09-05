import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getSiteTimezone } from '@/lib/config/timezone.server'
import { canReplyToInbox } from '@/modules/unified-inbox/lib/access'
import { getInbox, getSettings } from '@/modules/unified-inbox/lib/db'
import { assessReadiness } from '@/modules/unified-inbox/lib/campaigns/readiness'
import { forecastFinish, nextSlot } from '@/modules/unified-inbox/lib/campaigns/window'
import {
  campaignTally,
  getCampaign,
  listSteps,
  setCampaignStatus,
} from '@/modules/unified-inbox/lib/campaigns/store'
import { CampaignStateBody } from '@/modules/unified-inbox/lib/validation'

// Start, pause, resume, stop.
//
// Starting is the one with weight behind it, and it is the only place the full
// readiness check runs - DNS lookups included. Problems refuse outright.
// Warnings come back once, unaccepted, so the dialog can show them; pressing
// the button again with `acceptWarnings` gets past them. That is deliberately
// two presses: the entire cost of getting this wrong is paid by people who did
// not ask to be emailed.
//
// PAUSE TAKES EFFECT AT THE NEXT GAP, never mid-send. The runner claims one
// message at a time and settles it before looking again, so a pause arriving
// while something is going out lets that one finish and stops the next.
export const maxDuration = 60

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.campaigns')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const campaign = await getCampaign(id)
  if (!campaign) return errorResponse('That campaign is no longer here.', 404)

  const parsed = CampaignStateBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That could not be done.')
  const { action, acceptWarnings } = parsed.data

  if (action === 'pause') {
    if (campaign.status !== 'running') return errorResponse('It is not running.')
    await setCampaignStatus(id, 'paused', {
      pauseKind: 'manual',
      pauseReason: 'Paused. Whatever was going out at the time finished; nothing else has gone.',
    })
    return NextResponse.json({ ok: true })
  }

  if (action === 'stop') {
    if (campaign.status === 'done' || campaign.status === 'stopped') {
      return errorResponse('It has already finished.')
    }
    // Stopped, not deleted: what went out stays on the record, and the chases
    // that would have followed do not go.
    await setCampaignStatus(id, 'stopped', {
      pauseKind: 'manual',
      pauseReason: 'Stopped. Nothing further will go out, follow-ups included.',
      finishedAt: new Date(),
    })
    return NextResponse.json({ ok: true })
  }

  // Starting and resuming are the same check. A campaign that paused itself
  // three days ago because its list was full of dead addresses must not resume
  // without somebody being told what it found.
  const [steps, tally, timezone, settings] = await Promise.all([
    listSteps(id),
    campaignTally(id),
    getSiteTimezone(),
    getSettings(),
  ])

  if (!campaign.inboxId) return errorResponse('Choose the address this goes out from first.')
  if (!await canReplyToInbox(user, campaign.inboxId)) {
    return errorResponse('You cannot send from that address.', 403)
  }
  const inbox = await getInbox(campaign.inboxId)

  const readiness = await assessReadiness({
    campaign, steps, inbox, tally,
    postalAddress: settings.campaignFooterAddress,
    // The one place it is worth the wait: a campaign about to run for a
    // fortnight can afford two hundred milliseconds to find out whether it will
    // arrive anywhere.
    checkDns: true,
  })

  if (readiness.problems.length > 0) {
    return NextResponse.json(
      { error: 'It is not ready to go yet.', readiness },
      { status: 400 },
    )
  }
  if (readiness.warnings.length > 0 && !acceptWarnings) {
    return NextResponse.json(
      { ok: false, needsAcceptance: true, readiness },
      { status: 200 },
    )
  }

  const now = new Date()
  await setCampaignStatus(id, 'running', { startedAt: now })

  const remaining = tally.queued + tally.sending
  return NextResponse.json({
    ok: true,
    firstGoesAt: nextSlot(campaign.startAt && campaign.startAt > now ? campaign.startAt : now, campaign.window, timezone),
    finishesAbout: forecastFinish(remaining, campaign.window, timezone, now),
  })
}
