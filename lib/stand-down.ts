import { holdScheduledDrafts, recordEvent } from './db'
import type { Draft } from './types'

// ---------------------------------------------------------------------------
// Something has just been said on a conversation, so anything waiting to be
// said on it stops waiting.
//
// A message set to go out on Monday morning was written without Monday's post
// in front of it. If the conversation moves on before it leaves - the customer
// writes, or a colleague answers them first - sending it anyway is how the same
// question gets answered twice, or a question gets asked that has already been
// answered. So its departure time comes off, the writing stays exactly where it
// was as an ordinary draft, and the conversation says so in a line of its own,
// just before the message that caused it.
//
// Every road a message travels by comes through here, so the rule is one rule:
//
//   IN   - mail collected from a mailbox, a chat or a text collected from the
//          channel that owns it. Everything addressed to the sender stands
//          down (email only - that is the one with an address to match), and
//          every waiting REPLY on this conversation does, whoever it was to.
//   OUT  - a colleague answering: in this hub, from their own mail program, or
//          from a channel's own screens. Every waiting reply on this
//          conversation stands down except the ones the person answering wrote
//          themselves, which they plainly knew about. When who answered is not
//          known - a reply found in the Sent folder, a chat answered in the
//          channel's own app - that exception cannot be made, so it is
//          everybody's.
//
// What never comes here: the mail system talking to itself (an out-of-office,
// a bounce), post from a blocked sender, a note, and our own message coming
// back round from the Sent folder. The callers keep those out, the same way they
// already keep them from waking a snoozed conversation.
// ---------------------------------------------------------------------------

export type StandDownInput = {
  /** The conversation the message landed on. */
  threadId: string
  /** The message that did it. Every line this writes sits directly before it. */
  messageId: string | null
  direction: 'in' | 'out'
  /** Who wrote, for mail coming IN - matched against the To line of anything
   *  waiting, on every conversation. Null on a channel with no address. */
  fromAddress: string | null
  /** Which colleague answered, for mail going OUT, when that is known. */
  senderUserId: string | null
}

/**
 * Stand down whatever this message makes stale, and say so. Returns what was
 * stood down, so a caller that wants to can tell somebody.
 *
 * Never throws for the timeline's sake: the message has already landed or gone,
 * and a line that could not be written is not a reason to report that it had
 * not. A failure to HOLD does throw, because a scheduled message still queued
 * behind an answer it contradicts is exactly the thing this exists to prevent.
 */
export async function standDownScheduled(input: StandDownInput): Promise<Draft[]> {
  const theyWrote = input.direction === 'in'
  const held = await holdScheduledDrafts({
    threadId: input.threadId,
    address: theyWrote ? input.fromAddress : null,
    sameThread: true,
    exceptAuthorUserId: theyWrote ? null : input.senderUserId,
  })
  if (held.length === 0) return held

  try {
    await recordHeld(input, held)
  } catch (err) {
    console.error('[unified-inbox] stood scheduled messages down but could not say so', err)
  }
  return held
}

async function recordHeld(input: StandDownInput, held: Draft[]): Promise<void> {
  const cause = input.direction === 'in' ? 'they' : 'colleague'
  // Credited to the colleague who answered, when there was one we know of - the
  // line reads "Sam replied first". Their writing is what did it.
  const userId = cause === 'colleague' ? input.senderUserId : null

  // The conversation the message landed on hears about every one of them,
  // including the ones written on other conversations to the same person:
  // "they wrote before two messages waiting for them went out".
  await recordEvent(input.threadId, userId, 'held', heldDetail(held, {
    cause,
    address: input.fromAddress,
    messageId: input.messageId,
  }))

  // And each OTHER conversation a stood-down reply belonged to hears about its
  // own, because that is where somebody will go looking for it. Only ever the
  // address rule reaches another conversation, so the cause is always them.
  const elsewhere = new Map<string, Draft[]>()
  for (const draft of held) {
    if (!draft.threadId || draft.threadId === input.threadId) continue
    const list = elsewhere.get(draft.threadId)
    if (list) list.push(draft)
    else elsewhere.set(draft.threadId, [draft])
  }
  for (const [threadId, drafts] of elsewhere) {
    await recordEvent(threadId, null, 'held', heldDetail(drafts, {
      cause: 'they',
      address: input.fromAddress,
      messageId: null,
      elsewhereThreadId: input.threadId,
    }))
  }
}

/** What a held line needs to say itself, and to be matched back to its drafts:
 *  whose they were and how many, and which drafts - so the warning over a
 *  conversation can say why ITS draft stopped waiting. */
export function heldDetail(
  drafts: Pick<Draft, 'id' | 'authorUserId' | 'mode'>[],
  extra: {
    cause: 'they' | 'colleague'
    address: string | null
    messageId: string | null
    elsewhereThreadId?: string
  },
): Record<string, unknown> {
  return {
    cause: extra.cause,
    count: drafts.length,
    address: extra.address,
    ...(extra.messageId ? { messageId: extra.messageId } : {}),
    ...(extra.elsewhereThreadId ? { elsewhereThreadId: extra.elsewhereThreadId } : {}),
    draftIds: drafts.map((d) => d.id),
    authorUserIds: [...new Set(drafts.map((d) => d.authorUserId))],
    // 'reply' when every one of them was answering this conversation, so the
    // line can call it a reply rather than a message.
    allReplies: drafts.every((d) => d.mode === 'reply' || d.mode === 'reply-all'),
  }
}
