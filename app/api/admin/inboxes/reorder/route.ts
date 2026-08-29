import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { listInboxes, reorderInboxes } from '@/modules/unified-inbox/lib/db'
import { InboxOrderBody } from '@/modules/unified-inbox/lib/validation'

// The order of the rail, saved in one go.
//
// The whole list is posted, not "move this one up", because the rail is one
// list and its order is one fact. It is also why this asks for `manage`: the
// order is the site's, the same for everybody who opens the inbox, so the
// person who arranges it is the person who looks after the addresses. Anybody
// who may only read gets the rail as arranged and no drag handles at all.
export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const parsed = InboxOrderBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That is not an order this can save.')

  const ids = parsed.data.ids
  if (new Set(ids).size !== ids.length) return errorResponse('That is not an order this can save.')

  // Every inbox, exactly once. A partial list would leave the ones left out
  // sharing positions with the ones sent, and the rail would settle into an
  // order nobody chose the next time it was drawn.
  const existing = await listInboxes()
  const known = new Set(existing.map((i) => i.id))
  if (ids.length !== known.size || ids.some((id) => !known.has(id))) {
    return errorResponse('The inboxes have changed since that list was drawn. Reload and try again.', 409)
  }

  await reorderInboxes(ids)
  return NextResponse.json({ ok: true })
}
