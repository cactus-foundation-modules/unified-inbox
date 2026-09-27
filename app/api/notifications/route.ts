import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { arrivalsFor, nudgeLinks } from '@/modules/unified-inbox/lib/arrivals'
import { parseSince, type ArrivalsReply } from '@/modules/unified-inbox/lib/notify'

// "Has anything landed since you last asked?", for a browser the site cannot
// push to. See lib/notify.ts for the whole of the reasoning and lib/arrivals.ts
// for the half of it that touches the database - including the access rule,
// which runs through it unchanged.
//
// It is asked ONLY by a browser whose window is behind something else, only by
// somebody who has turned nudges on, and only when that browser is not being
// pushed to already. A tab in front of a reader refreshes its own list and asks
// this nothing.

export async function GET(request: Request) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.view')) return errorResponse('Forbidden', 403)

  // Read before the query rather than after it. Anything that lands while this
  // round is running has an instant later than this one and is therefore still
  // new next time, which is the failure worth avoiding. The other way round, a
  // message arriving in that same fraction of a second would be skipped for
  // good - and a nudge that never comes is not a bug anybody can see.
  const now = new Date()
  const since = parseSince(new URL(request.url).searchParams.get('since'), now.getTime())
  const links = await nudgeLinks()

  // No mark yet: the browser is only asking what the time is, so that the round
  // AFTER this one has something honest to measure from. Answered without
  // touching the conversations at all.
  const found = since
    ? await arrivalsFor(user, { kind: 'since', since }, now, links)
    : { arrivals: [], total: 0 }

  return NextResponse.json({
    now: now.toISOString(),
    ...found,
    listHref: links.listHref,
    icon: links.icon,
  } satisfies ArrivalsReply)
}
