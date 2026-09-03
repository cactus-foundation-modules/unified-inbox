import { assignThread, recordEvent, setThreadStatus } from './db'
import { followUpAt } from './scheduled'
import type { Draft } from './types'

// ---------------------------------------------------------------------------
// Chasing a message that has just gone out.
//
// A follow-up is stored on the draft as a length of time rather than a moment,
// so the moment is worked out here, from when the message actually left: one
// that went out late is chased late.
//
// TWO THINGS HAPPEN, and both of them matter.
//
// The conversation is SNOOZED until the chase is due. Expressed as a snooze
// deliberately: a reply already wakes a snoozed conversation (see
// reopenOnReply), so a chase nobody needs disappears the instant they write
// back, with nothing to remember to cancel. A reminder of its own would need
// cancelling, and the one time it was forgotten would be the time somebody
// chased a customer who had already answered.
//
// And it is HANDED TO WHOEVER WROTE IT - the draft's author, not whoever
// happened to press Send or set the time. A shared address means a colleague
// can finish and send somebody else's half-written message, and the row keeps
// the name it was started under precisely so that this question has an answer.
// The person waiting on a reply is the person who wrote the question, and a
// conversation coming back to the whole team is a conversation coming back to
// nobody in particular. It overwrites whoever the conversation was assigned to
// before, which is the point rather than a side effect, and the timeline says
// so.
//
// Never throws. By the time this runs the message has gone, and a conversation
// that stays in Open is a far smaller loss than a message reported as unsent.
// ---------------------------------------------------------------------------

export async function applyFollowUpAfterSend(
  draft: Pick<Draft, 'authorUserId' | 'followUpMinutes'>,
  threadId: string | null,
  sentAt: Date,
): Promise<void> {
  if (!draft.followUpMinutes || !threadId) return
  try {
    const at = followUpAt(sentAt, draft.followUpMinutes)
    await setThreadStatus(threadId, 'snoozed', at)
    await assignThread(threadId, draft.authorUserId)
    await recordEvent(threadId, null, 'awaiting', {
      minutes: draft.followUpMinutes,
      userId: draft.authorUserId,
    })
  } catch (err) {
    console.error('[unified-inbox] the message went out but could not be set to come back', err)
  }
}
