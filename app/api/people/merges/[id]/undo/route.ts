import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { undoMerge } from '@/modules/unified-inbox/lib/db'

// Putting a merge back. Only what the merge itself moved goes back, by id -
// anything that arrived afterwards stays where it arrived, because it was never
// the other person's and handing it over would be a second mistake.

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const result = await undoMerge(id, user.id)
  if ('error' in result) return errorResponse(result.error)

  return NextResponse.json({ ok: true, personId: result.personId, message: 'Put back.' })
}
