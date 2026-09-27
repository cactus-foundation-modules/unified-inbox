import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { canOpenThread } from '@/modules/unified-inbox/lib/access'
import {
  assignThread,
  closeDiscussionFor,
  getThreadDetail,
  reopenDiscussionFor,
  settleOwnMentionOn,
  recordEvent,
  setThreadRead,
  setThreadStatus,
  withdrawUndoneEvent,
} from '@/modules/unified-inbox/lib/db'
import { queueAssignmentWebhooks } from '@/modules/unified-inbox/lib/colleague-webhooks'
import { pushProviderRead } from '@/modules/unified-inbox/lib/provider-read'
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
    // Read here means read there, for a channel that keeps a state of its own.
    // Only the one way: no provider offers "mark it unread again", and the hub
    // marking it unread for one colleague is this hub's own bookkeeping rather
    // than a statement about the enquiry the far end is holding.
    if (!body.unread) await pushProviderRead(thread)
  }

  if (body.assigneeUserId !== undefined && body.assigneeUserId !== thread.assigneeUserId) {
    await assignThread(id, body.assigneeUserId)
    await recordEvent(id, user.id, 'assigned', { to: body.assigneeUserId })
    // Anything outside that wants to know it was handed to somebody. Queued
    // only, never to yourself, and never twice about the same post - see
    // lib/colleague-webhooks.ts.
    await queueAssignmentWebhooks({ threadId: id, assigneeUserId: body.assigneeUserId, byUserId: user.id })
  }

  if (body.status) {
    const until = body.snoozeUntil ? new Date(body.snoozeUntil) : null
    if (body.status === 'snoozed' && (!until || Number.isNaN(until.getTime()))) {
      return errorResponse('Say when it should come back.', 400)
    }

    // An internal discussion is several colleagues' work at once, so done is
    // done FOR YOU: the shared status stays where it is for everybody still
    // working on it (migrations/059_discussion_closures.sql). Opening it again,
    // or putting it to sleep, takes your own closing off first.
    if (thread.channel === 'discussion') {
      if (body.status === 'done') {
        await closeDiscussionFor(id, user.id)
        await settleOwnMentionOn(id, user.id)
        await noteStatusChange({ threadId: id, userId: user.id, status: 'done', until: null, was: 'open', wasUntil: null, forUserOnly: true })
        return NextResponse.json({ ok: true, thread: await getThreadDetail(id, user.id) })
      }
      await reopenDiscussionFor(id, user.id)
      // Nothing shared to change when it is already open for everybody - the
      // person was only reopening their own.
      if (body.status === 'open' && thread.status === 'open') {
        await noteStatusChange({ threadId: id, userId: user.id, status: 'open', until: null, was: 'done', wasUntil: null, forUserOnly: true })
        return NextResponse.json({ ok: true, thread: await getThreadDetail(id, user.id) })
      }
    }

    // Asked to be where it already is - an undo putting back a state that was
    // never left, or two tabs pressing the same button. Nothing changes, so
    // nothing is written: a timeline that says "marked it done" twice in a
    // row is recording presses, not the conversation.
    const wasUntil = thread.snoozeUntil ? thread.snoozeUntil.toISOString() : null
    const untilIso = until ? until.toISOString() : null
    const unchanged = body.status === thread.status && (body.status !== 'snoozed' || untilIso === wasUntil)
    // Finished with the conversation is finished with being asked about it -
    // even when somebody else had already marked it done, which is exactly when
    // the person asked to look presses Done to say they have.
    if (body.status === 'done') await settleOwnMentionOn(id, user.id)
    if (!unchanged) {
      await setThreadStatus(id, body.status, until)
      await noteStatusChange({
        threadId: id,
        userId: user.id,
        status: body.status,
        until: untilIso,
        was: thread.status,
        wasUntil,
        forUserOnly: false,
      })
    }
  }

  return NextResponse.json({ ok: true, thread: await getThreadDetail(id, user.id) })
}

/**
 * A line in the timeline for a change of where the conversation stands - or,
 * when this press is plainly taking back the one just made, the removal of
 * that line instead (see withdrawUndoneEvent).
 *
 * "Taking back" is read off the line itself: it records where the conversation
 * was before, and a change that puts it back exactly there, by the same person,
 * moments later, with nothing in between, is an undo whether it came from the
 * toast or from pressing the other button. Where it WAS is stored for that
 * reason and for the wording - "brought it back before its snooze ran out"
 * needs to know it had been snoozed.
 */
async function noteStatusChange(input: {
  threadId: string
  userId: string
  status: 'open' | 'snoozed' | 'done'
  until: string | null
  was: string
  wasUntil: string | null
  forUserOnly: boolean
}): Promise<void> {
  const own = input.forUserOnly ? { forUserOnly: true } : {}
  const goingBackTo = input.status === 'snoozed'
    ? { was: 'snoozed', wasUntil: input.until }
    : { was: input.status }
  const withdrawn = await withdrawUndoneEvent({
    threadId: input.threadId,
    userId: input.userId,
    kinds: ['status', 'snoozed'],
    detailMatch: { ...goingBackTo, ...own },
  })
  if (withdrawn) return
  await recordEvent(input.threadId, input.userId, input.status === 'snoozed' ? 'snoozed' : 'status', {
    status: input.status,
    until: input.until,
    was: input.was,
    wasUntil: input.wasUntil,
    ...own,
  })
}
