import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { canReplyToInbox } from '@/modules/unified-inbox/lib/access'
import { getCampaign } from '@/modules/unified-inbox/lib/campaigns/store'
import { sendOneRecipientNow } from '@/modules/unified-inbox/lib/campaigns/runner'
import { CampaignSendNowBody } from '@/modules/unified-inbox/lib/validation'

// "Send now" on one waiting person.
//
// The one place a campaign message leaves outside the tick. It is the same send
// through the same function - see the note on sendOneRecipientNow - and what it
// skips is only the waiting: the hours, the daily allowance and the gap since
// the last one. A run holding the address still comes first.
//
// Sending from an address is the same grant as replying from it, checked here
// as well as at start: a campaign somebody else set up must not become a way to
// send from a mailbox you are not allowed to send from.
export const maxDuration = 60

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.campaigns')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const campaign = await getCampaign(id)
  if (!campaign) return errorResponse('That campaign is no longer here.', 404)
  if (!campaign.inboxId) return errorResponse('The address this was sending from has been removed.')
  if (!await canReplyToInbox(user, campaign.inboxId)) {
    return errorResponse('You cannot send from that address.', 403)
  }

  const parsed = CampaignSendNowBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That could not be sent.')

  const result = await sendOneRecipientNow(id, parsed.data.recipientId)
  if (!result.ok) return errorResponse(result.error)

  return NextResponse.json({ ok: true, outcome: result.outcome })
}
