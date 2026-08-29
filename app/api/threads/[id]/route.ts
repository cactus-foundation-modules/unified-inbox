import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { canOpenThread } from '@/modules/unified-inbox/lib/access'
import {
  assignThread,
  getThreadDetail,
  recordEvent,
  setThreadRead,
  setThreadStatus,
} from '@/modules/unified-inbox/lib/db'
import { ThreadPatchBody } from '@/modules/unified-inbox/lib/validation'

// Working through a conversation: read it, hand it to somebody, put it to
// sleep, mark it done, open it again.
//
// Being able to READ an inbox is the bar here rather than being able to reply
// to it. Somebody who is allowed to see accounts@ but not send from it can
// still tidy up after themselves, and stopping them would only mean the list
// filling with conversations nobody may close.
//
// Every change writes an audit row beside it. "Who marked this done, and when"
// is the question asked a fortnight later, and a bare column cannot answer it.

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.view')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const thread = await getThreadDetail(id)
  if (!thread) return errorResponse('That conversation no longer exists.', 404)

  if (!await canOpenThread(user, thread)) return errorResponse('Forbidden', 403)

  const parsed = ThreadPatchBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That change does not look right.', 400)
  const body = parsed.data

  if (body.unread !== undefined && body.unread !== thread.unread) {
    await setThreadRead(id, body.unread)
  }

  if (body.assigneeUserId !== undefined && body.assigneeUserId !== thread.assigneeUserId) {
    await assignThread(id, body.assigneeUserId)
    await recordEvent(id, user.id, 'assigned', { to: body.assigneeUserId })
  }

  if (body.status) {
    const until = body.snoozeUntil ? new Date(body.snoozeUntil) : null
    if (body.status === 'snoozed' && (!until || Number.isNaN(until.getTime()))) {
      return errorResponse('Say when it should come back.', 400)
    }
    await setThreadStatus(id, body.status, until)
    await recordEvent(id, user.id, body.status === 'snoozed' ? 'snoozed' : 'status', {
      status: body.status,
      until: until ? until.toISOString() : null,
    })
  }

  return NextResponse.json({ ok: true, thread: await getThreadDetail(id) })
}
