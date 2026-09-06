import { assignThread, recordEvent, setThreadStatus } from './db'
import { followUpAt } from './scheduled'
import type { Draft } from './types'

// ---------------------------------------------------------------------------
// What happens to a conversation once a message on a timer has gone out.
//
// Two separate reasons a conversation might be asleep after a scheduled send,
// and they used to fight:
//
// A FOLLOW-UP is stored on the draft as a length of time rather than a moment,
// so the moment is worked out here, from when the message actually left: one
// that went out late is chased late. The conversation is SNOOZED until the
// chase is due, expressed as a snooze deliberately - a reply already wakes a
// snoozed conversation (see reopenOnReply), so a chase nobody needs disappears
// the instant they write back, with nothing to remember to cancel. A reminder
// of its own would need cancelling, and the one time it was forgotten would be
// the time somebody chased a customer who had already answered.
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
// A SNOOZE SOMEBODY SET THEMSELVES is the other reason, and it is the one that
// used to be lost. Setting a reply to go out on Monday morning and then putting
// the conversation to sleep until Friday is an ordinary pair of instructions -
// it is how you say "this goes out on Monday and I do not want to see it again
// until the end of the week" - and it is the pair the composer used to fold
// into one button, "Send later & snooze". That button has gone; the two
// instructions are given separately now, which means the send has to leave the
// sleep it finds alone. So the sleeping time is read before the message is
// posted and put back afterwards, and where there is also a chase the LATER of
// the two wins: a chase that fires while somebody has deliberately put the
// conversation away is a chase that wakes them up early.
//
// Never throws. By the time this runs the message has gone, and a conversation
// that stays in Open is a far smaller loss than a message reported as unsent.
// ---------------------------------------------------------------------------

/** Where a conversation stood before its scheduled message went out. */
export type ThreadSleep = { status: string; snoozeUntil: Date | null } | null

export type SleepPlan = {
  until: Date
  /** Whether this is the chase the message was written with, which is also
   *  handed to its author and written into the timeline - or merely the sleep
   *  the conversation was already having, put back. */
  chase: boolean
}

/**
 * How long the conversation should sleep once the message has gone.
 *
 * Pure, and tested as such: the two dates and the comparison between them are
 * the whole of the decision, and it is the sort of decision that is wrong by an
 * hour twice a year if it is worked out in three places.
 *
 * Null means leave the conversation exactly as it is - no chase was set and it
 * was not asleep, or the sleep it was having has already elapsed.
 */
export function plannedSleepAfterSend(input: {
  followUpMinutes: number | null
  sentAt: Date
  /** Where the conversation stood BEFORE the message was posted. */
  was: ThreadSleep
}): SleepPlan | null {
  const chaseAt = input.followUpMinutes
    ? followUpAt(input.sentAt, input.followUpMinutes)
    : null
  // Only a sleep that has not already run out. One due five minutes ago is a
  // conversation the next sweep would wake anyway, and putting it back would
  // hide something that is due to be looked at.
  const asleepUntil = input.was?.status === 'snoozed'
    && input.was.snoozeUntil
    && input.was.snoozeUntil.getTime() > input.sentAt.getTime()
    ? input.was.snoozeUntil
    : null

  if (chaseAt && asleepUntil) {
    return asleepUntil.getTime() > chaseAt.getTime()
      // Their own instruction outlasts the chase, so it wins the date - but the
      // chase was still asked for, and whoever wrote the message still wants it
      // back on their desk when it comes round.
      ? { until: asleepUntil, chase: true }
      : { until: chaseAt, chase: true }
  }
  if (chaseAt) return { until: chaseAt, chase: true }
  if (asleepUntil) return { until: asleepUntil, chase: false }
  return null
}

export async function applyFollowUpAfterSend(
  draft: Pick<Draft, 'authorUserId' | 'followUpMinutes'>,
  threadId: string | null,
  sentAt: Date,
  /** Where the conversation stood before the message went out, so a sleep
   *  somebody set themselves survives it. */
  was: ThreadSleep = null,
): Promise<void> {
  if (!threadId) return
  const plan = plannedSleepAfterSend({
    followUpMinutes: draft.followUpMinutes,
    sentAt,
    was,
  })
  if (!plan) return
  try {
    await setThreadStatus(threadId, 'snoozed', plan.until)
    // Only a chase moves the conversation onto somebody's desk. Putting a sleep
    // back is not a new instruction and must not quietly reassign anything.
    if (plan.chase) {
      await assignThread(threadId, draft.authorUserId)
      await recordEvent(threadId, null, 'awaiting', {
        minutes: draft.followUpMinutes,
        userId: draft.authorUserId,
      })
    }
  } catch (err) {
    console.error('[unified-inbox] the message went out but could not be set to come back', err)
  }
}
