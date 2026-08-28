import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { canReplyToInbox } from '@/modules/unified-inbox/lib/access'
import { getMessage } from '@/modules/unified-inbox/lib/db'
import { retrySend } from '@/modules/unified-inbox/lib/send'

// Another go at a message that failed to send.
//
// A failure has to be recoverable by the person who hit it, on the spot, or
// they will do the only other thing available and write the whole message
// again - which is how a customer ends up with the same reply twice. The retry
// reuses the original row and the original Message-ID, so it is the same
// message having another go rather than a second one.
export const maxDuration = 60

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.reply')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const message = await getMessage(id)
  if (!message) return errorResponse('That message no longer exists.', 404)
  if (!message.inboxId || !await canReplyToInbox(user, message.inboxId)) {
    return errorResponse('You do not have permission to send from that inbox.', 403)
  }

  const result = await retrySend(id)
  if (!result.ok) return errorResponse(result.reason, 400)

  return NextResponse.json({
    messageId: result.messageId,
    threadId: result.threadId,
    alreadySent: result.alreadySent,
  })
}
