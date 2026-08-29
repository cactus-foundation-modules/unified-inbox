import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { sweepRetention, sweepStalledSends } from '@/modules/unified-inbox/lib/retention'
import { pruneDeliveries } from '@/modules/unified-inbox/lib/webhooks-db'

// The daily tidy: the retention window, and the people it leaves holding
// nothing.
//
// A job of its own rather than another passenger on the mail tick. That tick's
// 25 second slice is already spoken for by collecting the mail, then the other
// channels, then working out whose conversations they are - and none of those
// can wait, whereas removing a year-old conversation eleven hours later than it
// might have been costs precisely nothing.
//
// Everything it does is batched and resumable. A site with ten years of mail
// and a twelve month window catches up over a number of nights rather than
// trying to do it in one, and each night's work is committed before the next
// begins.
//
// The schedule is honoured to the tick rather than to the minute, and on a free
// hosting plan the dispatcher itself only runs once a day - so this is "about
// once a day" rather than "at twenty to four".
export const maxDuration = 60

const BUDGET_MS = 18_000

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return errorResponse('CRON_SECRET is not configured', 503)

  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${secret}`) return errorResponse('Unauthorized', 401)

  // Belt and braces: the mail tick does this every hour, and doing it again
  // here costs one update against a partial index holding almost nothing. A
  // site whose mail tick is failing for some other reason still gets its stuck
  // messages marked rather than being left staring at "sending" for a week.
  const stalledSends = await sweepStalledSends()
  const retention = await sweepRetention({ deadline: Date.now() + BUDGET_MS })

  // What was sent, or given up on, a month ago is a log rather than a queue,
  // and a log nobody prunes is a table nobody meant to create.
  const webhookAttempts = await pruneDeliveries(30)

  return NextResponse.json({ ok: true, stalledSends, webhookAttempts, ...retention })
}
