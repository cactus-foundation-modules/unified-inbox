import { prisma } from '@/lib/db/prisma'
import { spamOwnerFor } from './spam'

// ---------------------------------------------------------------------------
// "Delete this", said by one person about one conversation.
//
// The bin is the junk folder's twin, and reading lib/spam.ts first will explain
// most of this file. The same shape, the same rule about whose folder something
// lands in, the same NOT EXISTS folded into the one place every list in the
// module already goes through. What is different is the ending: junk is refused
// for ever and never destroyed, while a bin can be emptied - and emptying it is
// the only thing on this screen that genuinely takes a customer's words away.
//
// Which is why the two are separate tables rather than one table with a column
// saying which. "I do not want to read this" and "I want this gone" are
// different decisions with different consequences, people make them about
// different post, and a single table would have made the Spam folder and the
// Bin two views of one pile that could not be emptied independently.
//
// NOTHING HERE TOUCHES A MAIL SERVER, and nothing here destroys anything on its
// own. A row in this table hides a conversation from one person's lists and
// does nothing else at all. It is undone by pressing the same button again, and
// there is no timer that empties the bin after a month - see migration 052 for
// why that is a deliberate absence rather than an oversight. What destroys is
// emptyBin() in lib/db.ts, which runs when somebody presses "Empty bin" and
// answers the question it puts up.
// ---------------------------------------------------------------------------

/**
 * WHOSE bin a conversation goes into when somebody presses the button.
 *
 * The junk rule, exactly - a shared address belongs to the team so the decision
 * is the presser's own, and a colleague's own address belongs to them so
 * somebody covering it fills THEIR bin rather than their own. See spamOwnerFor,
 * which is where it is written down at length.
 *
 * One implementation rather than two identical ones, because two would drift:
 * the day one of them started answering differently, half the module would
 * disagree with the other half about which folder a message went into, and the
 * person who could not find it would be told it was in a bin it was not in.
 */
export const binOwnerFor = spamOwnerFor

/**
 * The same question for one particular conversation. An internal discussion is
 * the exception: it belongs to every colleague in it, so deleting one only
 * ever fills the presser's own bin - covering a colleague's post does not get
 * to delete their discussions for them (migrations/059_discussion_closures.sql).
 */
export function binOwnerForThread(input: {
  pressedByUserId: string
  inbox: { kind: string; ownerUserId: string | null } | null
  channel: string
}): string {
  if (input.channel === 'discussion') return input.pressedByUserId
  return binOwnerFor(input)
}

/**
 * Split what an emptied bin holds into what may be destroyed and the
 * discussions that may not. A discussion is stamped out of this one person's
 * bin instead - still hidden from them, and untouched for everybody else in it.
 * Returns the ids that are safe to destroy.
 */
export async function purgeDiscussionsFromBin(threadIds: string[], ownerUserId: string): Promise<{
  destroy: string[]
  purged: number
}> {
  if (threadIds.length === 0) return { destroy: [], purged: 0 }
  const discussions = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "uin_threads"
     WHERE "id" = ANY(${threadIds}::text[]) AND "channel" = 'discussion'
  `
  const kept = new Set(discussions.map((r) => r.id))
  const purged = kept.size === 0 ? 0 : await prisma.$executeRaw`
    UPDATE "uin_thread_bin" SET "purged_at" = CURRENT_TIMESTAMP
     WHERE "thread_id" = ANY(${[...kept]}::text[])
       AND "user_id" = ${ownerUserId}
       AND "purged_at" IS NULL
  `
  return { destroy: threadIds.filter((id) => !kept.has(id)), purged }
}

/** Put a conversation in somebody's bin. Pressing it twice is pressing it once
 *  - the pair is the primary key, so this is safe to repeat and safe to race. */
export async function markThreadBinned(threadId: string, userId: string): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "uin_thread_bin" ("thread_id", "user_id")
    VALUES (${threadId}, ${userId})
    ON CONFLICT ("thread_id", "user_id") DO NOTHING
  `
}

/** Take it back out again. Also safe to repeat: taking something out of a bin
 *  it is not in is not an error. */
export async function unmarkThreadBinned(threadId: string, userId: string): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "uin_thread_bin"
     WHERE "thread_id" = ${threadId} AND "user_id" = ${userId}
  `
}

/**
 * Somebody has written on a conversation that was in the bin, so it comes back
 * out of every bin it was in - the same courtesy reopenOnReply pays a
 * conversation marked done, and for the same reason.
 *
 * The bin is a decision about what had been said WHEN the button was pressed.
 * A reply arriving afterwards is words nobody has seen, let alone chosen to
 * throw away, and migration 052 is plain that a bin holds only what somebody
 * put in it. Left where it was, the reply sat unread in a folder nobody opens -
 * and the next "Empty bin" would have destroyed it without anybody having read
 * a word of it, which is the one outcome this module exists to make impossible.
 *
 * Every person's bin, not one: nobody chose to throw away THIS message. Rows
 * already stamped purged are left alone - only a discussion survives an emptied
 * bin (purgeDiscussionsFromBin), and discussions never come through the
 * collecting pass that calls this.
 *
 * Returns how many bins it came out of, so the caller writes a timeline entry
 * only when something actually moved.
 */
export async function unbinOnReply(threadId: string): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM "uin_thread_bin"
     WHERE "thread_id" = ${threadId} AND "purged_at" IS NULL
  `
}

/** Whether it is in a given person's bin. Asked when a conversation is opened,
 *  so the button in the header offers the right one of the two rather than
 *  making somebody press it to find out - and asked about the OWNER rather than
 *  the reader, so that somebody covering Sam's post sees "Put it back" on a
 *  conversation Sam has already deleted and can do exactly that. */
export async function threadIsBinnedFor(threadId: string, userId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ one: number }[]>`
    SELECT 1 AS "one" FROM "uin_thread_bin"
     WHERE "thread_id" = ${threadId} AND "user_id" = ${userId}
     LIMIT 1
  `
  return rows.length > 0
}

/**
 * There is deliberately no countBinFor() here, for the reason lib/spam.ts gives
 * at the foot of itself: the number beside the folder comes from countThreads()
 * with `binOnly` set, so it carries the same visibility clause the folder's own
 * list carries. A tally of its own would have had to repeat that clause, and a
 * repeated clause drifts - which on this folder means a bin saying 4 with three
 * things in it, on the one screen where a missing item is something somebody
 * threw away and now cannot find.
 */
