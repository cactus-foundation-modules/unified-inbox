import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { runDueScheduledSends, SCHEDULED_BUDGET_MS } from '@/modules/unified-inbox/lib/scheduled-send'

// The messages somebody wrote earlier and asked to go out later.
//
// It runs inside the site's single cron dispatcher, which gives any one job 25
// seconds and then moves on to the next, so the budget below is short of that:
// the run finishes the message it is on, settles the row and returns, and
// whatever is still due goes on the next tick.
//
// How often that tick comes is the site's own arrangement rather than this
// module's - hourly on a paid Vercel plan, once a day on Hobby - which is why
// the composer says a message goes out "on or after" the time it is given
// rather than promising the minute. Somebody sitting in front of the inbox gets
// it sooner than that: Check now sends anything due before it looks for new
// mail, because a person watching the screen is the best clock there is.
//
// Vercel appends `Authorization: Bearer $CRON_SECRET` to its own cron requests
// automatically when CRON_SECRET is set - the same check every other cron route
// in this module makes.
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return errorResponse('CRON_SECRET is not configured', 503)

  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${secret}`) return errorResponse('Unauthorized', 401)

  const result = await runDueScheduledSends({ deadline: Date.now() + SCHEDULED_BUDGET_MS })

  return NextResponse.json({ ok: true, ...result })
}
