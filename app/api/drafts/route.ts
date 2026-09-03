import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getSiteTimezone } from '@/lib/config/timezone.server'
import { canOpenThread, canReplyToInbox, replyableInboxIds } from '@/modules/unified-inbox/lib/access'
import { allInboxIds, getThreadDetail, saveDraft } from '@/modules/unified-inbox/lib/db'
import { isWorthSaving } from '@/modules/unified-inbox/lib/drafts'
import { decideSendAt } from '@/modules/unified-inbox/lib/scheduled'
import { visibleProviderModules } from '@/modules/unified-inbox/lib/provider-registry'
import { DraftBody } from '@/modules/unified-inbox/lib/validation'

// Putting a message down half-written.
//
// The access rule is the send route's rule, checked here for the same reason it
// is checked there: this is where the session is. Somebody who may not write as
// accounts@ may not leave a draft sitting in it either - a draft is a send that
// has not happened yet, and the address on it is the address it would leave as.
//
// A draft on a conversation another module owns has no inbox to check, so the
// conversation itself is what decides, exactly as answering one does.
//
// Nothing here goes near a mail server, so there is no ceiling to raise: the
// bytes of an attachment are not fetched until somebody presses Send.

export async function POST(request: Request) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.reply')) return errorResponse('Forbidden', 403)

  const parsed = DraftBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return errorResponse(parsed.error.issues[0]?.message ?? 'That draft could not be read.', 400)
  }
  const body = parsed.data

  const to = body.to ?? []
  const cc = body.cc ?? []
  const attachments = body.attachments ?? []
  if (!isWorthSaving({ to, cc, subject: body.subject, body: body.body, attachments })) {
    return errorResponse('There is nothing to save yet.', 400)
  }

  const thread = body.threadId ? await getThreadDetail(body.threadId) : null
  if (body.threadId && !thread) {
    return errorResponse('That conversation no longer exists.', 404)
  }
  if (thread && !await canOpenThread(user, thread)) {
    return errorResponse('You do not have permission to write on that conversation.', 403)
  }
  if (thread?.providerModule) {
    const allowed = await visibleProviderModules(user)
    if (!allowed.includes(thread.providerModule)) {
      return errorResponse('You do not have permission to write on that conversation.', 403)
    }
  }

  // The address it would leave as, which is the thing worth checking. A reply
  // takes the conversation's, so an unfiled conversation and a channel both
  // land on null and are governed by the check above instead.
  const inboxId = body.inboxId ?? thread?.inboxId ?? null
  if (inboxId && !await canReplyToInbox(user, inboxId)) {
    return errorResponse('You do not have permission to send from that inbox.', 403)
  }

  // ---- a time on it, if it is going out on its own ------------------------
  //
  // Everything the send route would refuse at three in the morning is refused
  // here instead, while somebody is standing there who can fix it. A scheduled
  // message that quietly fails is worse than one that was never scheduled: the
  // screen said it was going.
  // Undefined means the save said nothing about a time, so whatever is already
  // on the draft stays. Null means somebody pressed Cancel the timer.
  let sendAt: Date | null | undefined = body.sendAt === undefined ? undefined : null
  if (body.sendAt) {
    const decision = decideSendAt(body.sendAt, new Date(), await getSiteTimezone())
    if (!decision.ok) return errorResponse(decision.reason, 400)
    sendAt = decision.at

    if (!inboxId && !thread) {
      return errorResponse('Pick which of your addresses it should go out from first.', 400)
    }
    if (!body.body.trim()) {
      return errorResponse('There is nothing written in it to send.', 400)
    }
    // A reply takes its recipients and its subject off the conversation when
    // its time comes, so only a message starting one has to carry them now.
    if (!thread) {
      if (to.length === 0) return errorResponse('Say who it is going to.', 400)
      if (!body.subject?.trim()) return errorResponse('Give the message a subject.', 400)
    }
  }

  // Finishing a colleague's draft is allowed on an address this person may send
  // from, so the save has to know which those are. Its own id is not enough.
  const sendableIds = await replyableInboxIds(user, await allInboxIds())

  const draft = await saveDraft({
    id: body.id ?? null,
    authorUserId: user.id,
    replyableInboxIds: sendableIds,
    inboxId,
    threadId: thread?.id ?? null,
    mode: body.mode,
    to,
    cc,
    subject: body.subject?.trim() || null,
    body: body.body,
    attachments,
    sendAt,
  })

  return NextResponse.json({
    id: draft.id,
    savedAt: draft.updatedAt.toISOString(),
    sendAt: draft.sendAt ? draft.sendAt.toISOString() : null,
  })
}
