import {
  claimDueScheduledDrafts,
  deleteDraft,
  failScheduledDraft,
  getThread,
  releaseScheduledClaims,
  releaseStaleScheduledClaims,
  threadSleep,
} from './db'
import { canUserOpenThread, canUserReplyToInbox, userCanReply } from './access'
import { draftSendingInboxId, postDraft } from './draft-send'
import { draftBodyText } from './drafts'
import { applyFollowUpAfterSend } from './follow-up'
import { STALE_CLAIM_MS } from './scheduled'
import type { Draft } from './types'

// ---------------------------------------------------------------------------
// Posting the messages whose time has come.
//
// This is the one place in the module that sends something with nobody sitting
// there, so it is also the one place that has to answer, on its own, every
// question the send route answers with a session in its hand:
//
//   May this still go? Rights are checked AT THE MOMENT IT LEAVES, against the
//   person who wrote it, not against the rights they had when they scheduled
//   it. Somebody taken off accounts@ on Friday does not have a message leave as
//   accounts@ on Monday. A refusal is written on the draft in English and the
//   writing is kept - a scheduled message that is silently dropped is worse
//   than one that never sent, because nobody finds out.
//
//   Can it go twice? No, twice over. The claim moves the row out of
//   'scheduled' in the same statement that finds it, so a second run walks
//   past it; and the idempotency key handed to the send route is derived from
//   the draft's own id, so even two claims that somehow both ran would land on
//   one message.
//
// HOW a draft becomes a message is not here: that is postDraft in
// lib/draft-send.ts, shared with the colleague who presses Send on one by hand.
// What is here is the half that road cannot borrow - whether it may still go at
// all, asked of the person who WROTE it rather than of anybody standing there.
//
// Budget rather than a queue: this runs inside the site's cron dispatcher,
// which gives any one job a slice and then moves on. Whatever is not sent this
// time is still due next time, and a message going out a tick late is the shape
// of the whole feature.
// ---------------------------------------------------------------------------

/** How long a single run will keep starting new sends. Short of the
 *  dispatcher's own slot, so the run finishes the message it is on and returns
 *  rather than being cut off mid-send. */
export const SCHEDULED_BUDGET_MS = 20_000

/** How many are taken in one claim. A site with fifty messages due at nine
 *  sends them over a few ticks rather than trying to hold fifty mail
 *  conversations open inside one function. */
export const SCHEDULED_BATCH = 10

export type ScheduledRunResult = {
  /** Claims from a run that died, put back for this one or the next. */
  released: number
  sent: number
  failed: number
  /** True when the batch was cut short by the clock, so there is more waiting. */
  moreDue: boolean
}

/**
 * One pass over the queue.
 *
 * `deadline` is wall-clock: the loop stops STARTING sends once it is past,
 * rather than abandoning one halfway.
 */
export async function runDueScheduledSends(options?: {
  now?: Date
  deadline?: number
}): Promise<ScheduledRunResult> {
  const now = options?.now ?? new Date()
  const deadline = options?.deadline ?? Date.now() + SCHEDULED_BUDGET_MS

  // First, cheaply: anything a previous run took and never settled. Nothing was
  // sent - the claim happens before the send - so it goes back in the queue
  // rather than being reported as a failure to somebody who would then send it
  // again by hand.
  const released = await releaseStaleScheduledClaims(new Date(now.getTime() - STALE_CLAIM_MS))

  const due = await claimDueScheduledDrafts(now, SCHEDULED_BATCH)

  let sent = 0
  let failed = 0
  let moreDue = due.length === SCHEDULED_BATCH

  for (let index = 0; index < due.length; index++) {
    const draft = due[index]!
    if (Date.now() > deadline) {
      // Out of time with rows still claimed. Exactly the ones this run took and
      // has not touched go back, by id: releasing by age here would disturb a
      // claim another run is still working through. The next tick has them.
      await releaseScheduledClaims(due.slice(index).map((d) => d.id))
      moreDue = true
      break
    }
    // Where the conversation stood before the message went out. Read HERE, on
    // purpose: a message set to go out on Monday morning on a conversation
    // somebody has put to sleep until Friday must still be asleep on Tuesday,
    // and the only moment that is knowable is before the send. See follow-up.ts.
    const was = draft.threadId ? await threadSleep(draft.threadId) : null
    const outcome = await sendOneScheduled(draft)
    if (outcome.ok) {
      sent += 1
      // Chase it up, if it was written with a chase on it, and put back any
      // sleep it was already having. Its own failure is not the send's failure:
      // the message has gone, and a conversation that stays in Open rather than
      // being put to sleep is a smaller loss than a message reported as unsent.
      await applyFollowUpAfterSend(draft, outcome.threadId, new Date(), was)
      // The message has gone, so the draft it was written in goes with it -
      // exactly as it does when somebody presses Send themselves.
      await deleteDraft(draft.id, draft.authorUserId)
    } else {
      failed += 1
      await failScheduledDraft(draft.id, outcome.reason)
    }
  }

  return { released, sent, failed, moreDue }
}

async function sendOneScheduled(
  draft: Draft,
): Promise<{ ok: true; threadId: string } | { ok: false; reason: string }> {
  if (!draftBodyText(draft).trim()) {
    return { ok: false, reason: 'There was nothing written in it by the time it was due.' }
  }

  const thread = draft.threadId ? await getThread(draft.threadId) : null
  if (draft.threadId && !thread) {
    return { ok: false, reason: 'The conversation it answered is no longer here.' }
  }

  // ---- may it still go, this minute --------------------------------------
  //
  // Everything below this comment and above the post is the half that is NOT
  // shared with a colleague pressing Send by hand: this road answers for the
  // person who wrote it, and that one answers for the person standing there.
  if (thread?.providerModule) {
    // Both halves, as everywhere else this module answers a channel: the
    // channel's own permission, and the right to answer anything at all.
    if (!await canUserOpenThread(draft.authorUserId, thread) || !await userCanReply(draft.authorUserId)) {
      return { ok: false, reason: 'Whoever wrote it can no longer answer this conversation.' }
    }
  } else {
    const inboxId = draftSendingInboxId(draft, thread)
    if (!inboxId) {
      return {
        ok: false,
        reason: 'There is no address left to send it from, so it stayed here.',
      }
    }
    // The rights that matter are the ones held now, not the ones held when the
    // time was set.
    if (!await canUserReplyToInbox(draft.authorUserId, inboxId)) {
      return {
        ok: false,
        reason: 'Whoever wrote it can no longer send from that address, so it stayed here.',
      }
    }
    if (thread && !await canUserOpenThread(draft.authorUserId, thread)) {
      return {
        ok: false,
        reason: 'Whoever wrote it can no longer open that conversation, so it stayed here.',
      }
    }
  }

  return postDraft(draft, thread, {
    sentByUserId: draft.authorUserId,
    // The draft's own id, so a claim that somehow ran twice sends one message.
    idempotencyKey: `scheduled-${draft.id}`,
  })
}
