import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getConnection, listConnections } from '@/modules/unified-inbox/lib/db'
import { syncAllConnections, syncConnection } from '@/modules/unified-inbox/lib/sync'
import { MANUAL_BUDGET_MS, MANUAL_PEOPLE_DEADLINE_MS } from '@/modules/unified-inbox/lib/sync-plan'
import { runPeoplePass } from '@/modules/unified-inbox/lib/identity'

// Check now. Same engine as the hourly job, a bigger slice of clock (E9): this
// runs in a module route with a 60 second ceiling of its own rather than inside
// the dispatcher's 25 second slot, so a first collection visibly moves along
// while somebody is watching it happen.
//
// The cooldown is a minute. Pressing the button repeatedly cannot help - iCloud
// caps concurrent connections per account, and the per-account lock would turn
// the second press away anyway.
export const maxDuration = 60

const COOLDOWN_MS = 60_000

export async function POST(request: Request) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const body = await request.json().catch(() => ({}))
  const connectionId = typeof body?.connectionId === 'string' ? body.connectionId : null

  const connections = connectionId
    ? [await getConnection(connectionId)].filter((c): c is NonNullable<typeof c> => !!c)
    : await listConnections()

  if (connections.length === 0) {
    return errorResponse('There is no mail account set up yet.', 400)
  }

  const tooSoon = connections.find(
    (c) => c.lastSyncAt && Date.now() - c.lastSyncAt.getTime() < COOLDOWN_MS
  )
  if (tooSoon) {
    const waitSeconds = Math.ceil((COOLDOWN_MS - (Date.now() - tooSoon.lastSyncAt!.getTime())) / 1000)
    return errorResponse(`A check has just run - give it ${waitSeconds} seconds and try again.`, 429)
  }

  const started = Date.now()
  const outcomes = connectionId
    ? [await syncConnection(connectionId, { budgetMs: MANUAL_BUDGET_MS })]
    : await syncAllConnections({ budgetMs: MANUAL_BUDGET_MS })

  // Same people pass the hourly job runs, with the bigger slice this route has.
  await runPeoplePass({ deadline: started + MANUAL_PEOPLE_DEADLINE_MS })

  const failed = outcomes.find((o) => !o.ok)
  const collected = outcomes.reduce((total, o) => total + o.stored, 0)
  const stillWorking = outcomes.some((o) => o.folders.some((f) => !f.backfillComplete))

  return NextResponse.json({
    ok: !failed,
    collected,
    stillWorking,
    error: failed?.error ?? null,
    message: failed
      ? failed.error
      : collected === 0
        ? 'Nothing new to collect.'
        : `Collected ${collected} message${collected === 1 ? '' : 's'}.${stillWorking ? ' Still working through your older mail in the background.' : ''}`,
  })
}
