import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { setRailOrder } from '@/modules/unified-inbox/lib/db'
import { RailOrderBody } from '@/modules/unified-inbox/lib/validation'

// The order the top of the rail sits in, for the person who dragged it.
//
// The one order in this module that does NOT ask for `manage`. The shared
// addresses, the colleagues' inboxes and the channels are the site's - one
// arrangement everybody opens - so arranging them belongs to whoever looks
// after the place. "Yours" is one person's own handful of places and nobody
// else ever sees it, so the only permission it needs is the one that lets them
// into the hub at all.
//
// Replaced outright rather than merged, which is the other difference. What the
// rail posts is every entry under Yours, all of which was on the screen of the
// person dragging - there is no part of it belonging to somebody who could not
// see it, and therefore nothing to keep a place for. Nothing is checked against
// the addresses either: an id naming an address they are later taken off simply
// never matches an entry, which is cheaper and quieter than refusing a save.
export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const allowed = await hasPermission(user, 'unifiedinbox.view')
    || await hasPermission(user, 'unifiedinbox.manage')
  if (!allowed) return errorResponse('Forbidden', 403)

  const parsed = RailOrderBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That is not an order this can save.')

  const keys = parsed.data.keys
  if (new Set(keys).size !== keys.length) return errorResponse('That is not an order this can save.')

  await setRailOrder(user.id, keys)
  return NextResponse.json({ ok: true })
}
