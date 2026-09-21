import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { canOpenThread, canViewInbox } from '@/modules/unified-inbox/lib/access'
import { getInbox, getThreadDetail, moveThreadToInbox, recordEvent } from '@/modules/unified-inbox/lib/db'
import { ThreadMoveBody } from '@/modules/unified-inbox/lib/validation'

// POST - move a conversation to another mailbox.
//
// What dragging a row onto a mailbox in the rail posts. After it, the
// conversation is listed under the new mailbox and replies leave from the new
// address - not because anything here says so, but because both already read
// the one column this changes. See `moveThreadToInbox`.
//
// Two grants, and both are needed. You must be able to open the conversation -
// nobody moves what they cannot see - and you must be able to see the mailbox it
// is going INTO. The second is what stops mail being dropped into a colleague's
// own post by somebody who has never been given it: the rail does not draw that
// mailbox for them, and this is the half that holds when the rail is not the
// thing calling.
//
// A discussion is refused. It belongs to the people it was put to, not to an
// address, and its place in each of their posts is worked out from who they are.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'unifiedinbox.view'))) return errorResponse('Forbidden', 403)

  const { id } = await params
  const thread = await getThreadDetail(id)
  if (!thread) return errorResponse('That conversation no longer exists.', 404)
  if (!(await canOpenThread(user, thread))) return errorResponse('Forbidden', 403)

  const parsed = ThreadMoveBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That change does not look right.', 400)
  const { inboxId } = parsed.data

  if (thread.channel === 'discussion') {
    return errorResponse('A discussion belongs to the people in it rather than to a mailbox, so it cannot be moved.', 409)
  }
  if (thread.mergedIntoId) {
    return errorResponse('That conversation has been merged into another one. Move that one instead.', 409)
  }

  const target = await getInbox(inboxId)
  if (!target) return errorResponse('That mailbox is not there any more.', 404)
  if (!(await canViewInbox(user, inboxId))) return errorResponse('Forbidden', 403)

  if (thread.inboxId === inboxId && (thread.absorbedInboxIds ?? []).length === 0) {
    return NextResponse.json({ ok: true, moved: false, fromInboxId: inboxId, inboxId })
  }

  const from = thread.inboxId ? await getInbox(thread.inboxId) : null
  const moved = await moveThreadToInbox(id, inboxId)
  if (!moved) return errorResponse('That conversation no longer exists.', 404)

  await recordEvent(id, user.id, 'moved', {
    fromInboxId: moved.fromInboxId,
    fromName: from?.name ?? null,
    toInboxId: inboxId,
    toName: target.name,
  })

  return NextResponse.json({ ok: true, moved: true, fromInboxId: moved.fromInboxId, inboxId })
}
