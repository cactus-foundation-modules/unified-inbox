import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getCampaign, setCampaignArchived } from '@/modules/unified-inbox/lib/campaigns/store'
import { CampaignArchiveBody } from '@/modules/unified-inbox/lib/validation'

// Putting a finished campaign away, and getting it back.
//
// Only one that is over - finished, or stopped for good. Anything still able to
// send is something somebody needs to be able to see on the main list, and a
// draft is either a campaign about to happen or one to delete, not one to file.
// Nothing about what was sent, to whom, or what became of it changes: the
// Archived tab shows the same campaign, with the same table under it.
export const maxDuration = 60

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.campaigns')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const campaign = await getCampaign(id)
  if (!campaign) return errorResponse('That campaign is no longer here.', 404)

  const parsed = CampaignArchiveBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('Say whether to archive it or bring it back.')

  if (parsed.data.archived && campaign.status !== 'done' && campaign.status !== 'stopped') {
    return errorResponse(
      campaign.status === 'draft'
        ? 'A draft has not been sent, so there is nothing to archive. Delete it instead if it is not wanted.'
        : 'This one can still send. Stop it for good first, then it can be archived.',
    )
  }

  await setCampaignArchived(id, parsed.data.archived)
  return NextResponse.json({ ok: true })
}
