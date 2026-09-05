import { timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { getCampaignTickToken } from '@/modules/unified-inbox/lib/db'
import { CAMPAIGN_BUDGET_MS, runDueCampaigns } from '@/modules/unified-inbox/lib/campaigns/runner'

// The tick that moves campaigns along, and the only address that can be reached
// from outside.
//
// TWO WAYS IN, because the pace of a campaign is the pace of this tick.
//
//   The site's own scheduled round, which carries `Authorization: Bearer
//   $CRON_SECRET` exactly as every other cron route in this module expects. On
//   most hosting it comes past once an hour, which is right for a chase due on
//   Thursday and far too slow for one message every ninety seconds.
//
//   A key in the address, for whatever minute-by-minute pinger the site would
//   rather use - the free ones cannot set headers, which is why the key is in
//   the query string and why it is long. It is the same bargain the Brevo
//   webhook address strikes.
//
// A tick that arrives too early sends nothing: the gap between messages lives
// in the database, on the sending address's own lane, and this only ever asks
// whether the moment has come. So pinging it every ten seconds is harmless and
// pinging it once a day is slow, and neither can produce a burst.
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const authorised = await isAuthorised(request)
  if (!authorised.ok) return errorResponse(authorised.reason, authorised.status)

  const result = await runDueCampaigns({ deadline: Date.now() + CAMPAIGN_BUDGET_MS })
  return NextResponse.json({ ok: true, ...result })
}

export async function POST(request: NextRequest) {
  return GET(request)
}

async function isAuthorised(
  request: NextRequest,
): Promise<{ ok: true } | { ok: false; reason: string; status: number }> {
  const secret = process.env.CRON_SECRET
  const header = request.headers.get('authorization')
  if (secret && header && matches(header, `Bearer ${secret}`)) return { ok: true }

  const given = request.nextUrl.searchParams.get('key') ?? ''
  if (given) {
    const expected = await getCampaignTickToken()
    if (expected && matches(given, expected)) return { ok: true }
  }

  if (!secret && !given) return { ok: false, reason: 'CRON_SECRET is not configured', status: 503 }
  return { ok: false, reason: 'Unauthorized', status: 401 }
}

function matches(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  // Different lengths cannot be compared in constant time, and are wrong anyway.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
