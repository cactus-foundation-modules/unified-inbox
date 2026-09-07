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
import { draftBodyText } from './drafts'
import { applyFollowUpAfterSend } from './follow-up'
import { plainTextToHtml, STALE_CLAIM_MS } from './scheduled'
import { sendMessage } from './send'
import { sendProviderReply } from './provider-send'
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
): Promise<{ ok: true; threadId: string | null } | { ok: false; reason: string }> {
  if (!draftBodyText(draft).trim()) {
    return { ok: false, reason: 'There was nothing written in it by the time it was due.' }
  }

  const thread = draft.threadId ? await getThread(draft.threadId) : null
  if (draft.threadId && !thread) {
    return { ok: false, reason: 'The conversation it answered is no longer here.' }
  }

  // A conversation another module owns - a chat, an enquiry, a text. It goes
  // back out the way it came in, and its rights are that module's own.
  if (thread?.providerModule) {
    if (draft.mode === 'forward' || draft.mode === 'new') {
      return { ok: false, reason: 'This kind of conversation can be replied to, but not forwarded.' }
    }
    // Both halves, as everywhere else this module answers a channel: the
    // channel's own permission, and the right to answer anything at all.
    if (!await canUserOpenThread(draft.authorUserId, thread) || !await userCanReply(draft.authorUserId)) {
      return { ok: false, reason: 'Whoever wrote it can no longer answer this conversation.' }
    }
    const result = await sendProviderReply({
      threadId: thread.id,
      // A body written in the box is markup with the catalogue slotted into it,
      // and what survives of the markup is the channel's own answer - so it
      // goes over as it stands and is rendered there. One written before the
      // box could hold any is words already and has nothing to render.
      body: draft.bodyFormat === 'html'
        ? { html: draft.body }
        : { text: draftBodyText(draft) },
      authorUserId: draft.authorUserId,
      authorName: null,
      products: draft.products,
    })
    return result.ok ? { ok: true, threadId: thread.id } : { ok: false, reason: result.reason }
  }

  const inboxId = draft.inboxId ?? thread?.inboxId ?? null
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

  const result = await sendMessage({
    threadId: draft.threadId ?? undefined,
    inboxId,
    // Whichever message it was written against, so a reply set for Monday
    // quotes the message somebody answered rather than whatever arrived over
    // the weekend. Null is the newest, which is what it always did.
    inReplyToMessageId: draft.inReplyToMessageId ?? undefined,
    mode: draft.mode,
    to: draft.to.length > 0 ? draft.to : undefined,
    cc: draft.cc.length > 0 ? draft.cc : undefined,
    bcc: draft.bcc.length > 0 ? draft.bcc : undefined,
    subject: draft.subject ?? undefined,
    // Stored as it was typed, which is what makes the box give back what went
    // into it. A body written in the new box already IS markup and goes as it
    // stands; one written before the box could hold any is escaped here, at the
    // last moment, the same way the composer used to do it.
    bodyHtml: draft.bodyFormat === 'html' ? draft.body : plainTextToHtml(draft.body),
    attachments: draft.attachments.map((file) => ({
      key: file.key,
      url: file.url,
      filename: file.filename,
      contentType: file.contentType,
    })),
    // Read fresh as it goes out, which is the whole reason a draft stores
    // references rather than prices: a quotation set for Monday morning quotes
    // Monday morning's catalogue.
    products: draft.products,
    includeOriginalAttachments: draft.mode === 'forward',
    // The draft's own id, so a claim that somehow ran twice sends one message.
    idempotencyKey: `scheduled-${draft.id}`,
    authorUserId: draft.authorUserId,
  })

  // The conversation the message landed on, which for one starting a new
  // conversation did not exist until a moment ago - and is exactly the one a
  // follow-up has to be set on.
  return result.ok ? { ok: true, threadId: result.threadId } : { ok: false, reason: result.reason }
}
