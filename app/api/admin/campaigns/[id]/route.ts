import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getSiteTimezone } from '@/lib/config/timezone.server'
import { canReplyToInbox } from '@/modules/unified-inbox/lib/access'
import { getInbox, getSettings } from '@/modules/unified-inbox/lib/db'
import { decideSendAt } from '@/modules/unified-inbox/lib/scheduled'
import { assessReadiness } from '@/modules/unified-inbox/lib/campaigns/readiness'
import { clockToMinute, forecastFinish, isCalendarDate } from '@/modules/unified-inbox/lib/campaigns/window'
import {
  campaignTally,
  deleteCampaign,
  exclusionSummary,
  getCampaign,
  listSteps,
  previewRecipients,
  replaceSteps,
  setCampaignCategories,
  updateCampaign,
} from '@/modules/unified-inbox/lib/campaigns/store'
import { previewFor } from '@/modules/unified-inbox/lib/campaigns/personalise'
import { CampaignPatchBody } from '@/modules/unified-inbox/lib/validation'

// One campaign: reading it, correcting it, and throwing it away.
//
// The edit rule is the one worth stating. A DRAFT may be changed in every way.
// A campaign that has started may have its later steps and its clock changed -
// a chase nobody has reached yet is still only writing - but not its first
// message and not its list: four hundred people have had the old wording, and
// changing it now means two versions of the same mailshot with no way to tell
// which anybody got.
export const maxDuration = 60

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.campaigns')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const campaign = await getCampaign(id)
  if (!campaign) return errorResponse('That campaign is no longer here.', 404)

  const [steps, tally, timezone, settings, exclusions] = await Promise.all([
    listSteps(id),
    campaignTally(id),
    getSiteTimezone(),
    getSettings(),
    exclusionSummary(id),
  ])
  const inbox = campaign.inboxId ? await getInbox(campaign.inboxId) : null

  // Three real people off the list, so the preview shows the contact whose
  // first name is "Accounts Dept" rather than a made-up Jane Smith.
  const samples = await previewRecipients(id, 3)
  const first = steps.find((s) => s.stepIndex === 0)
  const previews = samples.map((person) => ({
    address: person.address,
    ...previewFor({ subject: first?.subject ?? '', body: first?.body ?? '' }, person),
  }))

  // The cheap half of the readiness check on every read, so the screen can
  // colour the steps in. The DNS lookup only happens when somebody actually
  // tries to start it.
  const readiness = await assessReadiness({
    campaign, steps, inbox, tally,
    postalAddress: settings.campaignFooterAddress,
    checkDns: false,
  })

  const remaining = tally.queued + tally.sending

  return NextResponse.json({
    ok: true,
    campaign,
    steps,
    tally,
    exclusions,
    previews,
    readiness,
    timezone,
    finishesAbout: remaining > 0
      ? forecastFinish(remaining, campaign.window, timezone, new Date())
      : null,
  })
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.campaigns')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const campaign = await getCampaign(id)
  if (!campaign) return errorResponse('That campaign is no longer here.', 404)

  const parsed = CampaignPatchBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That change could not be saved.')
  const data = parsed.data
  const isDraft = campaign.status === 'draft'

  if (data.inboxId !== undefined && data.inboxId && !await canReplyToInbox(user, data.inboxId)) {
    return errorResponse('You cannot send from that address.', 403)
  }
  if (!isDraft && data.inboxId !== undefined && data.inboxId !== campaign.inboxId) {
    return errorResponse('The address it sends from cannot be changed once it has started. Stop it first.')
  }
  if (!isDraft && data.categoryIds !== undefined) {
    return errorResponse('Who it goes to cannot be changed once it has started. Use Top up to add people who have joined since.')
  }

  const timezone = await getSiteTimezone()

  // The start time is a wall clock with no zone on it, exactly as the composer's
  // own "send later" box is, and it means what the site's clock says.
  let startAt: Date | null | undefined
  if (data.startAt !== undefined) {
    if (data.startAt === null) {
      startAt = null
    } else {
      const decision = decideSendAt(data.startAt, new Date(), timezone)
      if (!decision.ok) return errorResponse(decision.reason)
      startAt = decision.at
    }
  }

  const window = data.window
    ? {
        ...(data.window.startTime !== undefined
          ? { startMinute: clockToMinute(data.window.startTime) ?? 480 } : {}),
        ...(data.window.endTime !== undefined
          ? { endMinute: clockToMinute(data.window.endTime) ?? 1020 } : {}),
        ...(data.window.weekdaysOnly !== undefined ? { weekdaysOnly: data.window.weekdaysOnly } : {}),
        ...(data.window.skipDates !== undefined
          ? { skipDates: data.window.skipDates.filter(isCalendarDate) } : {}),
        ...(data.window.intervalSeconds !== undefined ? { intervalSeconds: data.window.intervalSeconds } : {}),
        ...(data.window.jitterSeconds !== undefined ? { jitterSeconds: data.window.jitterSeconds } : {}),
        ...(data.window.dailyCap !== undefined ? { dailyCap: data.window.dailyCap } : {}),
        ...(data.window.rampEnabled !== undefined ? { rampEnabled: data.window.rampEnabled } : {}),
        ...(data.window.rampStart !== undefined ? { rampStart: data.window.rampStart } : {}),
      }
    : undefined

  // A window whose end is before its start sends nothing, for ever, without
  // saying so - refused here as well as by the column's own check, because the
  // person is standing here and can be told.
  if (window) {
    const start = window.startMinute ?? campaign.window.startMinute
    const end = window.endMinute ?? campaign.window.endMinute
    if (start >= end) {
      return errorResponse('The finishing time has to be after the starting time.')
    }
  }

  await updateCampaign(id, {
    ...(data.name !== undefined ? { name: data.name } : {}),
    ...(data.inboxId !== undefined ? { inboxId: data.inboxId } : {}),
    ...(data.includeSignature !== undefined ? { includeSignature: data.includeSignature } : {}),
    ...(data.includeUnsubscribe !== undefined ? { includeUnsubscribe: data.includeUnsubscribe } : {}),
    ...(data.copyToSent !== undefined ? { copyToSent: data.copyToSent } : {}),
    ...(data.excludeColleagues !== undefined ? { excludeColleagues: data.excludeColleagues } : {}),
    ...(startAt !== undefined ? { startAt } : {}),
    ...(window ? { window } : {}),
  })

  if (data.categoryIds !== undefined) await setCampaignCategories(id, data.categoryIds)

  if (data.steps !== undefined) {
    const existing = await listSteps(id)
    const firstChanged = data.steps.find((s) => s.stepIndex === 0)
    const currentFirst = existing.find((s) => s.stepIndex === 0)
    if (!isDraft && firstChanged && currentFirst
      && (firstChanged.body !== currentFirst.body || (firstChanged.subject ?? null) !== currentFirst.subject)) {
      return errorResponse(
        'The message itself cannot be changed once it has started sending - some people have had the old one. '
        + 'The follow-ups can still be edited.',
      )
    }
    await replaceSteps(id, data.steps.map((step) => ({
      stepIndex: step.stepIndex,
      waitDays: step.stepIndex === 0 ? null : (step.waitDays ?? 3),
      subject: step.subject ?? null,
      body: step.body,
    })))
  }

  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.campaigns')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const campaign = await getCampaign(id)
  if (!campaign) return errorResponse('That campaign is no longer here.', 404)
  if (campaign.status === 'running') {
    return errorResponse('Stop it before deleting it, so nothing goes out half way through being removed.')
  }

  // Whoever unsubscribed stays unsubscribed: the suppression rows point at the
  // campaign with ON DELETE SET NULL, so they lose the note about where they
  // came from and nothing else.
  await deleteCampaign(id)
  return NextResponse.json({ ok: true })
}
