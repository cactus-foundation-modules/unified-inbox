// ---------------------------------------------------------------------------
// The rules of a merge, kept away from the database.
//
// Which conversation wins, what the merged one says about itself, and who ends
// up able to read it. All three have a wrong answer that is quiet rather than
// loud - a merge into the wrong side buries the history under a subject nobody
// recognises, and a merge that widens who can read a restricted address is a
// privacy breach that looks exactly like a tidy inbox - so they live here,
// where they can be argued about in a test rather than in production.
// ---------------------------------------------------------------------------

/** The little a merge needs to know about a conversation to decide these
 *  things. Shaped so a caller can hand over a whole thread row and be right. */
export type MergeCandidate = {
  id: string
  inboxId: string | null
  /** Addresses this conversation has already absorbed, if it is itself the
   *  result of an earlier merge. Its own inbox is expected to be among them. */
  absorbedInboxIds?: string[]
  subject: string | null
  status: string
  unread: boolean
  createdAt: Date
}

/** Cap on one merge. Not a technical limit - it is the number above which
 *  somebody has almost certainly ticked the wrong box, and a merge of the
 *  whole page is the one mistake that takes longest to unpick. */
export const MAX_MERGE_SOURCES = 20

/**
 * The conversation the others fold into: the one that started it.
 *
 * Oldest wins rather than newest, and rather than "whichever you had open".
 * A merged conversation keeps the winner's subject and its place in the list,
 * and the thread that began the exchange is the one whose subject line people
 * recognise - the newest is usually the stray that a dropped References header
 * started halfway through. Ties break on id so the answer is stable: the same
 * five conversations must merge the same way whichever order they were ticked.
 */
export function pickWinner<T extends { id: string; createdAt: Date }>(threads: T[]): T | null {
  let best: T | null = null
  for (const thread of threads) {
    if (!best) { best = thread; continue }
    const a = thread.createdAt.getTime()
    const b = best.createdAt.getTime()
    if (a < b || (a === b && thread.id < best.id)) best = thread
  }
  return best
}

/** Every address a conversation belongs to. The absorbed list where there is
 *  one, its own inbox where there is not - never a union of the two, or a
 *  conversation merged into its own inbox would list it twice. */
export function effectiveInboxIds(thread: {
  inboxId: string | null
  absorbedInboxIds?: string[]
}): string[] {
  const absorbed = thread.absorbedInboxIds ?? []
  if (absorbed.length > 0) return [...new Set(absorbed)]
  return thread.inboxId ? [thread.inboxId] : []
}

/** The addresses the merged conversation will belong to: every address every
 *  side of it belongs to, once each, in the order they were met. */
export function mergedInboxIds(winner: MergeCandidate, losers: MergeCandidate[]): string[] {
  const out: string[] = []
  for (const thread of [winner, ...losers]) {
    for (const id of effectiveInboxIds(thread)) {
      if (!out.includes(id)) out.push(id)
    }
  }
  return out
}

/**
 * Where the merged conversation stands.
 *
 * An open half makes the whole thing open, and that is the only reading that is
 * safe: the alternative marks something done because the OTHER half of it was
 * dealt with, and a customer waiting on an answer disappears off the list. A
 * snooze survives only if every side was asleep, for the same reason.
 */
export function mergedStatus(statuses: string[]): string {
  if (statuses.some((s) => s === 'open')) return 'open'
  if (statuses.some((s) => s === 'snoozed')) return 'snoozed'
  return 'done'
}

/** Unread if any side was. Merging something read into something unread must
 *  not mark the unread half as seen - nobody has seen it. */
export function mergedUnread(flags: boolean[]): boolean {
  return flags.some(Boolean)
}

export type MergeRefusal = { error: string }

/**
 * Everything that makes a merge impossible before a single row is touched,
 * answered in the words the person asking would use.
 *
 * `alreadyMerged` is the interesting one: merging INTO something that has
 * itself been merged away would file the lot onto a conversation no list shows,
 * and merging away something already merged would strand the first merge's undo.
 */
export function validateMerge(input: {
  winnerId: string
  loserIds: string[]
  found: Map<string, { mergedIntoId: string | null }>
}): MergeRefusal | null {
  const loserIds = [...new Set(input.loserIds)]
  if (loserIds.length === 0) return { error: 'Pick at least one other conversation to merge in.' }
  if (loserIds.includes(input.winnerId)) {
    return { error: 'A conversation cannot be merged into itself.' }
  }
  if (loserIds.length > MAX_MERGE_SOURCES) {
    return { error: `That is more than ${MAX_MERGE_SOURCES} conversations at once. Do it in a few goes.` }
  }
  for (const id of [input.winnerId, ...loserIds]) {
    const thread = input.found.get(id)
    if (!thread) return { error: 'One of those conversations is no longer here.' }
    if (thread.mergedIntoId) {
      return {
        error: id === input.winnerId
          ? 'That conversation has itself been merged into another one. Merge into that one instead.'
          : 'One of those has already been merged into something else. Undo that first.',
      }
    }
  }
  return null
}

/**
 * The sentence the confirmation screen puts in front of somebody, when merging
 * would let more people read something than can read it now.
 *
 * This is the honest half of the decision that a merged conversation belongs to
 * every address on it. It is genuinely useful - marcus@ keeps sight of the
 * thread he started - and it genuinely widens the guest list, so the widening
 * is said out loud, with the addresses named, rather than discovered later.
 *
 * Null when nothing widens: one address, or every side already on the same set.
 */
export function widenedAccessWarning(input: {
  winner: MergeCandidate
  losers: MergeCandidate[]
  /** Inbox id to the name people know it by. */
  inboxNames: Map<string, string>
}): string | null {
  const merged = mergedInboxIds(input.winner, input.losers)
  if (merged.length < 2) return null

  const names = merged.map((id) => input.inboxNames.get(id) ?? 'another address')
  return `Everyone who can read ${listSentence(names)} will be able to read the whole of the merged conversation.`
}

/** "a", "a and b", "a, b and c". The Oxford comma is not ours. */
export function listSentence(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]!
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** What the merged conversation is called, for the line that reports what just
 *  happened. The winner's subject, or the plain truth when it has none. */
export function mergeSummary(winner: MergeCandidate, loserCount: number): string {
  const what = winner.subject?.trim() || 'the conversation'
  return loserCount === 1
    ? `Merged into ${what}.`
    : `${loserCount} conversations merged into ${what}.`
}

/**
 * Does this conversation belong to this address?
 *
 * The one question the threading rules and the guest list both ask, written
 * once. Before merging there was nothing to ask - a conversation had an inbox
 * and you compared it - and comparing the column directly is exactly what would
 * make a merge come apart on the next reply, so the comparison lives here
 * instead and every caller goes through it.
 *
 * A conversation belonging to no address at all matches only "no address",
 * which is how a chat and an unfiled email are told apart from a filed one.
 */
export function belongsToInbox(
  thread: { inboxId: string | null; absorbedInboxIds?: string[] },
  inboxId: string | null,
): boolean {
  const ids = effectiveInboxIds(thread)
  if (ids.length === 0) return inboxId === null
  return inboxId !== null && ids.includes(inboxId)
}
