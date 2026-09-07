import { prisma } from '@/lib/db/prisma'

// ---------------------------------------------------------------------------
// "This is junk", said by one person about one conversation.
//
// It is an opinion rather than a fact, which is the whole reason this is a
// table of pairs rather than a column on the conversation. A shared address has
// several people reading it, and the supplier newsletter one colleague files as
// junk is the one another reads every Tuesday. So marking something as junk
// takes it off YOUR lists and leaves everybody else's alone.
//
// Nothing is deleted, moved or hidden from anybody else. A conversation marked
// as junk keeps every message in it, keeps its place in every colleague's list,
// and comes straight back the moment its owner presses the button again.
//
// The FOLDER is the other side of the same row: what you have marked, newest
// first, because what you threw away most recently is what you are most likely
// to have thrown away by mistake.
//
// Where the actual filtering happens is lib/db.ts, in filterClauses - one
// NOT EXISTS on this table, on the one path every list, count and tally in the
// module already goes through. Adding it in each of them separately is how one
// of them ends up disagreeing with the others, which on a spam folder means
// junk that is out of the list and still in the count.
//
// THE ONE THING IN THE FOLDER THAT IS NOT AN OPINION is post from a sender the
// site has blocked. Nobody pressed anything for those: they are collected,
// stamped by the collecting pass and put in the bin for everybody, because a
// block is one list for the whole site rather than one person's view of one
// conversation. That stamp is a column on the conversation and not a row here -
// see setThreadBlocked in lib/db.ts and migration 044 - and the two clauses
// above read the pair of them together.
// ---------------------------------------------------------------------------

/**
 * WHOSE bin a conversation goes into when somebody presses the button.
 *
 * Not always the person pressing it, and that is the whole of this function.
 *
 *   A SHARED address - sales@, accounts@ - belongs to the team, so there is
 *   nobody whose post it is and the opinion is the presser's own. Their bin.
 *
 *   AN INDIVIDUAL ADDRESS belongs to one named colleague, and so does the post
 *   in it. Somebody covering Sam's inbox while Sam is away is working Sam's
 *   post on Sam's behalf: the junk they clear out is junk out of Sam's bin, not
 *   out of theirs. Their own spam folder is for their own post and would
 *   otherwise slowly fill with a fortnight of somebody else's rubbish, which is
 *   both useless to them and a small privacy problem nobody asked for.
 *
 *   Which comes to the same thing when it is your OWN individual address: you
 *   are the owner, so it is your bin either way.
 *
 * THE CONVERSATION'S OWN ADDRESS DECIDES, never the addresses a merge has since
 * added to it. A conversation merged across Sam's address and the team's has one
 * home and several guests, and one home is an answer that can be explained;
 * "whichever of the two owners the query happened to return first" is not.
 * Hiding is deliberately wider than this - see spamMatch in lib/db.ts - because
 * showing somebody post its owner has already binned is the worse of the two
 * mistakes.
 *
 * Pure, and given the inbox rather than an id, so the caller does the fetching
 * and this stays the piece that can be tested. Null inbox is a conversation
 * filed nowhere at all - an unrouted email, a chat, a call - which has no owner
 * and therefore belongs to whoever threw it away.
 */
export function spamOwnerFor(input: {
  /** Whoever pressed the button, from the session and never from a request. */
  pressedByUserId: string
  inbox: { kind: string; ownerUserId: string | null } | null
}): string {
  const { inbox } = input
  if (inbox && inbox.kind === 'individual' && inbox.ownerUserId) return inbox.ownerUserId
  return input.pressedByUserId
}

/** Mark a conversation as junk, for one person. Pressing it twice is pressing
 *  it once - the pair is the primary key, so this is safe to repeat and safe to
 *  race. */
export async function markThreadSpam(threadId: string, userId: string): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "uin_thread_spam" ("thread_id", "user_id")
    VALUES (${threadId}, ${userId})
    ON CONFLICT ("thread_id", "user_id") DO NOTHING
  `
}

/** Take it back out again. Also safe to repeat: taking something out of a
 *  folder it is not in is not an error, it is a Tuesday. */
export async function unmarkThreadSpam(threadId: string, userId: string): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "uin_thread_spam"
     WHERE "thread_id" = ${threadId} AND "user_id" = ${userId}
  `
}

/** Whether it is in a given person's bin. Asked when a conversation is opened,
 *  so the button in the header offers the right one of the two rather than
 *  making somebody press it to find out - and asked about the OWNER rather than
 *  the reader, so that somebody covering Sam's post sees "Not junk" on a
 *  conversation Sam has already binned and can put it back.
 *
 *  The site's own stamp counts as well, and it has to. Post from a blocked
 *  sender is in the bin without anybody having pressed anything, so there is no
 *  row here to find - and a header offering "Junk" on a conversation the reader
 *  is looking at INSIDE the spam folder is a button that cannot get it out
 *  again. See setThreadBlocked in lib/db.ts for the other half. */
export async function threadIsSpamFor(threadId: string, userId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ one: number }[]>`
    SELECT 1 AS "one" FROM "uin_threads" t
     WHERE t."id" = ${threadId}
       AND (
         t."blocked_at" IS NOT NULL
         OR EXISTS (
              SELECT 1 FROM "uin_thread_spam" sp
               WHERE sp."thread_id" = t."id" AND sp."user_id" = ${userId}
            )
       )
     LIMIT 1
  `
  return rows.length > 0
}

/**
 * There is deliberately no countSpamFor() here.
 *
 * The number beside the folder on the rail comes from countThreads() with
 * `spamOnly` set, exactly like every other count on this screen. A tally of its
 * own would have had to repeat the visibility clause - which addresses this
 * reader may open, which channels, whether they see unfiled post - and a
 * repeated clause is a clause that drifts. The failure that buys is a folder
 * saying 4 with three things in it, on the one screen where a missing item
 * means somebody threw away a message they cannot now find.
 */
