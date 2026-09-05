import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { CAMPAIGN_BUDGET_MS, runDueCampaigns } from '@/modules/unified-inbox/lib/campaigns/runner'

// The tick the Campaigns screen makes while somebody has it open.
//
// The same engine as the scheduled round and the outside pinger, with no
// special rules of its own - a second sending path is a second set of bugs, and
// the second one always sends the duplicate. All this adds is a session and a
// permission, so a campaign cannot be driven along by anybody who happens to
// know the address.
//
// A tick arriving before the gap has elapsed sends nothing at all, so the
// screen can ask as often as it likes.
export const maxDuration = 60

export async function POST() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.campaigns')) return errorResponse('Forbidden', 403)

  const result = await runDueCampaigns({ deadline: Date.now() + CAMPAIGN_BUDGET_MS })
  return NextResponse.json({ ok: true, ...result })
}
