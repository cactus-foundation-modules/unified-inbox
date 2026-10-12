import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { errorResponse } from '@/lib/utils'
import { syncOneProvider, PROVIDER_BUDGET_MS } from '@/modules/unified-inbox/lib/provider-sync'
import { NUDGE_BUDGET_MS, sendPushNudges } from '@/modules/unified-inbox/lib/push-nudges'

// One channel, now: what lib/conversation-arrived.ts calls when another module
// announces something new in one of its conversations. A route of its own
// rather than a function the listener imports, because the listener sits in
// the generated server registry that public pages read, and any import from it
// - even a lazy one - drags the collection path (and every admin component the
// provider registry reaches) into the public client graph.
//
// Same lock as the cron tick: Bearer CRON_SECRET. Copies the channel, then
// sends the push nudges for whatever that filed, as the tick does.
export const maxDuration = 30

const Body = z.object({ providerId: z.string().min(1).max(200) })

export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return errorResponse('CRON_SECRET is not configured', 503)
  if (request.headers.get('authorization') !== `Bearer ${secret}`) return errorResponse('Unauthorized', 401)

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('Invalid body')

  const channel = await syncOneProvider(parsed.data.providerId, { deadline: Date.now() + PROVIDER_BUDGET_MS })
  const nudges = await sendPushNudges({ deadline: Date.now() + NUDGE_BUDGET_MS })
  return NextResponse.json({ ok: true, channel, nudges })
}
