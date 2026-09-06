import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { canOpenThread } from '@/modules/unified-inbox/lib/access'
import { getThreadDetail, getThreadMerge, undoThreadMerge } from '@/modules/unified-inbox/lib/db'

// Putting one merge back.
//
// Only what that merge moved goes back, and only from where it put it -
// anything that arrived afterwards belongs to the merged conversation and stays
// there. Undoing a merge nobody could have made requires being able to open the
// conversation it was made ON, which is the one that still exists.

export const maxDuration = 60

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const merge = await getThreadMerge(id)
  if (!merge) return errorResponse('That merge is not on record.', 404)

  const winner = await getThreadDetail(merge.winnerId)
  if (!winner) return errorResponse('That conversation no longer exists.', 404)
  if (!await canOpenThread(user, winner)) return errorResponse('Forbidden', 403)

  const result = await undoThreadMerge(id, user.id)
  if ('error' in result) return errorResponse(result.error)

  return NextResponse.json({ ok: true, threadId: result.loserId, message: 'Put back.' })
}
