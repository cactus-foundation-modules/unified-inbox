import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { listConnections } from '@/modules/unified-inbox/lib/db'

// The hourly mail check. The manifest declares this path, so it has to answer
// from the moment the module is installed - the sync engine itself arrives in
// the next stage, and until then this reports what it would have collected
// from rather than pretending to have collected it.
//
// The dispatcher honours a schedule to the tick, not to the minute, and the
// tick is hourly on a paid Vercel plan and once a DAY on Hobby. Whatever this
// route eventually does, it has to be resumable: a bounded batch, committed,
// cursor advanced, return.
//
// Vercel appends `Authorization: Bearer $CRON_SECRET` to its own cron requests
// automatically when CRON_SECRET is set - no separate secret scheme needed.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return errorResponse('CRON_SECRET is not configured', 503)

  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${secret}`) return errorResponse('Unauthorized', 401)

  const connections = await listConnections()
  return NextResponse.json({
    ok: true,
    connections: connections.length,
    collected: 0,
    note: 'Mail collection is not switched on in this version.',
  })
}
