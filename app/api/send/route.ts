import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { canReplyToInbox } from '@/modules/unified-inbox/lib/access'
import { getThread } from '@/modules/unified-inbox/lib/db'
import { sendMessage } from '@/modules/unified-inbox/lib/send'
import { SendBody } from '@/modules/unified-inbox/lib/validation'

// Sending a message: a reply, a reply to everybody, a forward, or a new
// conversation started from here (D12).
//
// Access is checked HERE rather than in lib/send.ts, because this is where the
// session is. Holding unifiedinbox.reply is not enough on its own - the inbox
// being written FROM has its own guest list, and somebody who cannot read
// accounts@ must not be able to send as it either (D16).
//
// The 60 second ceiling is for the attachments: the bytes are fetched out of
// storage, and a message carrying a few megabytes of quote PDFs takes longer
// than a bare reply.
export const maxDuration = 60

export async function POST(request: Request) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.reply')) return errorResponse('Forbidden', 403)

  const parsed = SendBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return errorResponse(parsed.error.issues[0]?.message ?? 'That message could not be read.', 400)
  }
  const body = parsed.data

  const inboxId = body.inboxId ?? (body.threadId ? (await getThread(body.threadId))?.inboxId : null)
  if (!inboxId) {
    return errorResponse(
      'This conversation is not filed in an inbox yet, so there is nothing to send it from.',
      400,
    )
  }
  if (!await canReplyToInbox(user, inboxId)) {
    return errorResponse('You do not have permission to send from that inbox.', 403)
  }

  const result = await sendMessage({ ...body, authorUserId: user.id })

  // A refusal is a 400 with a sentence, never a 500 with a stack trace. The
  // person reading it is deciding what to do next.
  if (!result.ok) return errorResponse(result.reason, 400)

  return NextResponse.json({
    messageId: result.messageId,
    threadId: result.threadId,
    alreadySent: result.alreadySent,
  })
}
