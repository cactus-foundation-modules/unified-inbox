import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { canReplyToInbox, replyableInboxIds } from '@/modules/unified-inbox/lib/access'
import { allInboxIds, discardDraftAfterSend, getThread } from '@/modules/unified-inbox/lib/db'
import { applyFollowUpAfterSend } from '@/modules/unified-inbox/lib/follow-up'
import { htmlToText } from '@/modules/unified-inbox/lib/html'
import { sendMessage } from '@/modules/unified-inbox/lib/send'
import { sendProviderReply } from '@/modules/unified-inbox/lib/provider-send'
import { visibleProviderModules } from '@/modules/unified-inbox/lib/provider-registry'
import { SendBody } from '@/modules/unified-inbox/lib/validation'

// Sending a message: a reply, a reply to everybody, a forward, or a new
// conversation started from here (D12).
//
// Access is checked HERE rather than in lib/send.ts, because this is where the
// session is. Holding unifiedinbox.reply is not enough on its own - the inbox
// being written FROM has its own guest list, and somebody who cannot read
// accounts@ must not be able to send as it either (D16).
//
// A conversation that came from another channel takes the other road entirely:
// it has no inbox and no sending identity, and its reply goes back out through
// the module that owns it so the customer gets a real reply on the channel they
// used. Its access rule is that module's own permission, for the same reason -
// this hub presenting somebody else's messages is not the same as granting
// somebody the right to read them.
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

  const thread = body.threadId ? await getThread(body.threadId) : null

  // ---- a channel somebody else owns --------------------------------------
  if (thread?.providerModule) {
    const allowed = await visibleProviderModules(user)
    if (!allowed.includes(thread.providerModule)) {
      return errorResponse('You do not have permission to answer this conversation.', 403)
    }
    if (body.mode === 'forward' || body.mode === 'new') {
      return errorResponse(
        'This kind of conversation can be replied to, but not forwarded or started from here.',
        400,
      )
    }
    const result = await sendProviderReply({
      threadId: thread.id,
      // These channels carry words, not markup - a chat window and a text
      // message have nowhere to put a typeface.
      text: htmlToText(body.bodyHtml),
      authorUserId: user.id,
      authorName: user.displayName ?? null,
    })
    if (!result.ok) return errorResponse(result.reason, 400)
    const discarded = await discardDraftAfterSend(
      body.draftId, user.id, await replyableInboxIds(user, await allInboxIds()),
    )
    // A draft written with a chase on it is chased whoever sends it, and by
    // hand as much as on the clock - pressing Send an hour early is still
    // sending it.
    if (discarded) await applyFollowUpAfterSend(discarded, thread.id, new Date())
    return NextResponse.json({ messageId: result.messageId, threadId: thread.id, alreadySent: false })
  }

  // ---- email -------------------------------------------------------------
  const inboxId = body.inboxId ?? thread?.inboxId ?? null
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

  // The draft it was written in, now that the message has genuinely gone. A
  // draft that outlives its own send is the reply somebody sends again next
  // week, having found it still sitting in the list.
  const discarded = await discardDraftAfterSend(
    body.draftId, user.id, await replyableInboxIds(user, await allInboxIds()),
  )

  // And the chase it was written with, if it was written with one. It goes to
  // whoever WROTE it rather than to whoever pressed Send: on a shared address a
  // colleague can finish somebody else's message, and the person waiting on an
  // answer is the one who asked the question. Skipped when the same press
  // arrives twice - the second one sent nothing, and the conversation has
  // already been put to sleep.
  if (discarded && !result.alreadySent) await applyFollowUpAfterSend(discarded, result.threadId, new Date())

  return NextResponse.json({
    messageId: result.messageId,
    threadId: result.threadId,
    alreadySent: result.alreadySent,
  })
}
