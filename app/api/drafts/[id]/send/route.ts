import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { canOpenThread, canReplyToInbox } from '@/modules/unified-inbox/lib/access'
import {
  deleteDraft,
  getDraftInInbox,
  getInboxAudience,
  getThread,
  standDownScheduledDraft,
  threadSleep,
} from '@/modules/unified-inbox/lib/db'
import { postDraft } from '@/modules/unified-inbox/lib/draft-send'
import { canSendDraftForOwner, draftBodyText } from '@/modules/unified-inbox/lib/drafts'
import { applyFollowUpAfterSend } from '@/modules/unified-inbox/lib/follow-up'
import { visibleChannelKeys } from '@/modules/unified-inbox/lib/provider-registry'
import { SendDraftForBody } from '@/modules/unified-inbox/lib/validation'

// Sending a colleague's draft out for them.
//
// The one thing that may be done with somebody else's half-written reply, and
// it is deliberately narrow: it goes exactly as it stands. Nothing here reads a
// body out of the request, so there is no road by which a colleague's message
// leaves their address saying something they did not type - the row in the
// table is the message, and this is a button that posts it.
//
// It exists for the case the privacy rule costs: a finished quote sitting on
// the address of somebody who is on leave, which used to wait for them. The
// person pressing the button is already reading every word of it.
//
// WHO MAY. Three questions, all answered here because this is where the session
// is, and answered against the address the screen was looking at rather than
// against anything worked out from the draft:
//
//   1. May they send from that address at all - canReplyToInbox, which is the
//      same grant the send route checks and is separate from reading (D16).
//   2. Is this the shape the folder is for - canSendDraftForOwner: somebody's
//      OWN address, holding their OWN draft. Not a shared address, and not
//      somebody else's writing that happens to be filed there.
//   3. And, once it is fetched, whatever the conversation itself asks - a
//      channel wants that module's permission, exactly as answering one does.
//
// A request naming a draft that is not the owner's, or not on that address,
// finds nothing at all rather than being told which of the two it got wrong.
//
// The 60 second ceiling is the send route's, and for the same reason: the bytes
// of the attachments are fetched out of storage before anything leaves.
export const maxDuration = 60

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.reply')) return errorResponse('Forbidden', 403)

  const parsed = SendDraftForBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return errorResponse('That draft could not be read.', 400)
  }
  const { inboxId } = parsed.data

  const mayReply = await canReplyToInbox(user, inboxId)
  if (!mayReply) {
    return errorResponse('You do not have permission to send from that address.', 403)
  }
  const inbox = await getInboxAudience(inboxId)
  if (!inbox) return errorResponse('That address is not here any more.', 404)

  const { id } = await params
  // Whose it is comes from the ADDRESS rather than from the request: the folder
  // under somebody's name holds the owner's drafts, and letting a caller name
  // the author would be letting them ask about anybody's.
  const owner = inbox.ownerUserId
  const draft = owner ? await getDraftInInbox(id, owner, inboxId) : null
  if (!draft || !canSendDraftForOwner(draft, inbox, mayReply)) {
    return errorResponse('That draft is not here any more.', 404)
  }

  if (!draftBodyText(draft).trim()) {
    return errorResponse('There is nothing written in it to send.', 400)
  }

  const thread = draft.threadId ? await getThread(draft.threadId) : null
  if (draft.threadId && !thread) {
    return errorResponse('The conversation it answers is no longer here.', 404)
  }
  if (thread) {
    if (!await canOpenThread(user, thread)) {
      return errorResponse('You do not have permission to answer that conversation.', 403)
    }
    if (thread.providerModule) {
      const allowed = await visibleChannelKeys(user)
      if (!allowed.includes(thread.providerModule)) {
        return errorResponse('You do not have permission to answer that conversation.', 403)
      }
    }
  }

  // The timer, if the author put one on it between the folder being drawn and
  // this button being pressed. Cleared before a byte leaves, in the one
  // statement that also refuses a row the queue is already posting - which is
  // what makes exactly one of the two send it. See standDownScheduledDraft.
  if (await standDownScheduledDraft(draft.id, draft.authorUserId) === 'in-flight') {
    return errorResponse(
      'That one is already on its way out on its own. Give it a moment and look in Sent.',
      409,
    )
  }

  // Where the conversation stood before the message went out, read here on
  // purpose: a sleep somebody set themselves has to survive the send.
  const was = draft.threadId ? await threadSleep(draft.threadId) : null

  const result = await postDraft(draft, thread, {
    // Credited to whoever pressed the button, because that is who sent it. What
    // the customer sees is unchanged - an address that is somebody's own signs
    // as them whoever presses Send - but Sent should say who actually did.
    sentByUserId: user.id,
    // Its own key rather than the queue's, so the two roads cannot be mistaken
    // for one another, and stable per draft so a double press is one email.
    idempotencyKey: `on-behalf-${draft.id}`,
  })
  if (!result.ok) return errorResponse(result.reason, 400)

  // The message has gone, so the draft goes with it - by its AUTHOR, which is
  // the only name the row answers to.
  await deleteDraft(draft.id, draft.authorUserId)
  // And the chase the author wrote it with, if they wrote it with one. It is
  // still theirs: they asked for it.
  await applyFollowUpAfterSend(draft, result.threadId, new Date(), was)

  return NextResponse.json({ threadId: result.threadId })
}
