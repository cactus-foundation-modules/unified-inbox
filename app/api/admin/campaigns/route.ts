import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getSiteTimezone } from '@/lib/config/timezone.server'
import { canReplyToInbox } from '@/modules/unified-inbox/lib/access'
import { DEFAULT_WINDOW, forecastFinish } from '@/modules/unified-inbox/lib/campaigns/window'
import {
  campaignTally,
  createCampaign,
  listCampaigns,
  replaceSteps,
  setCampaignCategories,
} from '@/modules/unified-inbox/lib/campaigns/store'
import { CampaignBody } from '@/modules/unified-inbox/lib/validation'

// The campaigns themselves: the list, and starting a new one.
//
// Both take `unifiedinbox.campaigns` rather than `manage`. Somebody who may
// rename a folder or fix a mail account is not, by that fact, somebody who may
// email five thousand customers, and the two grants being separate is what lets
// a site give one without the other.
export const maxDuration = 60

export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.campaigns')) return errorResponse('Forbidden', 403)

  const timezone = await getSiteTimezone()
  const campaigns = await listCampaigns()

  // The counts ride along, because a list of campaigns with no numbers on it is
  // a list of names. One query each, and the list is short by nature - a site
  // with four hundred campaigns is a site using the wrong tool.
  const rows = await Promise.all(campaigns.map(async (campaign) => {
    const tally = await campaignTally(campaign.id)
    const remaining = tally.queued + tally.sending
    return {
      ...campaign,
      tally,
      // Roughly when the last one goes, said as "roughly" on the screen too.
      finishesAbout: campaign.status === 'running' && remaining > 0
        ? forecastFinish(remaining, campaign.window, timezone, new Date())
        : null,
    }
  }))

  return NextResponse.json({ ok: true, campaigns: rows, timezone })
}

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.campaigns')) return errorResponse('Forbidden', 403)

  const parsed = CampaignBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That campaign could not be saved.')
  const data = parsed.data

  // Sending from an address is the same grant as replying from it. A campaign
  // is a great many replies, and it must not be a way round that.
  if (data.inboxId && !await canReplyToInbox(user, data.inboxId)) {
    return errorResponse('You cannot send from that address.', 403)
  }

  const id = await createCampaign({
    name: data.name,
    inboxId: data.inboxId ?? null,
    createdBy: user.id,
  })

  if (data.categoryIds) await setCampaignCategories(id, data.categoryIds)

  // A campaign always has a step 0, even an empty one: the editor opens on the
  // message, and a screen with nothing to type in is a screen that looks broken.
  await replaceSteps(id, data.steps?.length
    ? data.steps.map((step) => ({
        stepIndex: step.stepIndex,
        waitDays: step.stepIndex === 0 ? null : (step.waitDays ?? 3),
        subject: step.subject ?? null,
        body: step.body,
      }))
    : [{ stepIndex: 0, waitDays: null, subject: null, body: '' }])

  return NextResponse.json({ ok: true, id, defaults: DEFAULT_WINDOW })
}
