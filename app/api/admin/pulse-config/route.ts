import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermissions } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getSettings, listConnections } from '@/modules/unified-inbox/lib/db'
import { countRunningCampaigns } from '@/modules/unified-inbox/lib/campaigns/store'

/** What the admin-wide mail pulse needs to decide whether to tick. */
export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)

  const permissions = await hasPermissions(user, [
    'unifiedinbox.manage',
    'unifiedinbox.campaigns',
  ])

  const canManage = permissions['unifiedinbox.manage'] === true
  const canCampaign = permissions['unifiedinbox.campaigns'] === true

  const [settings, connections, runningCampaigns] = await Promise.all([
    canManage || canCampaign ? getSettings() : Promise.resolve(null),
    canManage ? listConnections() : Promise.resolve([]),
    canCampaign ? countRunningCampaigns() : Promise.resolve(0),
  ])

  return NextResponse.json({
    autoCheckSeconds: canManage ? settings?.autoCheckSeconds ?? null : null,
    hasConnections: canManage && connections.length > 0,
    canCampaign,
    runningCampaigns: canCampaign ? runningCampaigns : 0,
  })
}
