import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { listInboxes, reorderInboxes } from '@/modules/unified-inbox/lib/db'
import { mergeOrder } from '@/modules/unified-inbox/lib/list'
import { InboxOrderBody } from '@/modules/unified-inbox/lib/validation'

// The order of the addresses down the rail, saved in one go.
//
// The whole rail as that person sees it is posted, not "move this one up",
// because a rail is one list and its order is one fact. It asks for `manage`
// because the order is the site's, the same for everybody who opens the inbox,
// so the person who arranges it is the person who looks after the addresses.
// Anybody who may only read gets the addresses as arranged and nothing
// draggable at all.
//
// What arrives is nonetheless a PARTIAL list, and always was. A colleague's own
// inbox is on the screens of the colleagues named on it and nowhere else -
// `manage` is deliberately not a key to somebody's personal post (see
// lib/access.ts) - so even an administrator can be arranging six addresses out
// of eight. So the posted order is poured back into the site's own rather than
// replacing it: what was sent lands in the slots those addresses already held,
// and an address nobody saw keeps the one it had. Refusing the save instead,
// which is what this did, meant a site with one personal inbox on it could not
// rearrange its rail at all.
export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const parsed = InboxOrderBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That is not an order this can save.')

  const ids = parsed.data.ids
  if (new Set(ids).size !== ids.length) return errorResponse('That is not an order this can save.')

  // An id naming no inbox is a rail drawn before somebody deleted one, which is
  // worth saying out loud: the order on the screen is not the order being
  // saved, and reloading is the only way to be sure which is which.
  const existing = await listInboxes()
  const known = new Set(existing.map((i) => i.id))
  if (ids.some((id) => !known.has(id))) {
    return errorResponse('The inboxes have changed since that list was drawn. Reload and try again.', 409)
  }

  await reorderInboxes(mergeOrder(existing.map((i) => i.id), ids))
  return NextResponse.json({ ok: true })
}
