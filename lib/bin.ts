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
