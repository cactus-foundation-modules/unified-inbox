import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { deleteDraft } from '@/modules/unified-inbox/lib/db'

// Throwing a draft away.
//
// No ownership check beyond the one in the query, because the query IS the
// check: a draft is deleted by id AND author, so a request naming somebody
// else's draft deletes nothing and is told the same thing as a request naming
// one that has already gone. Answering "that is not yours" would confirm it
// exists, which is the whole of what a draft has to hide.

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.reply')) return errorResponse('Forbidden', 403)

  const { id } = await params
  await deleteDraft(id, user.id)

  // Pressing Discard twice is not an error, and neither is discarding one that
  // another tab has already sent.
  return NextResponse.json({ ok: true })
}
