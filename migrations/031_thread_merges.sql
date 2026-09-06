-- Two conversations that were always one conversation.
--
-- The hub splits mail up for good reasons and gets it wrong often enough to
-- matter. A customer writes from their work address on Monday and their phone
-- on Thursday, so there are two threads. A supplier changes the subject line
-- and their client drops the References header, so the heuristic gives up and
-- starts a second. A colleague forwards something in and there are suddenly
-- three. And `020_internal_threads.sql` deliberately makes TWO conversations
-- out of one email between two of the site's own addresses, which is right
-- until somebody decides that this particular back-and-forth is one story with
-- four people in it rather than four stories with one person each.
--
-- So: merge. Pick the conversations, and they become one.
--
-- Three things had to be built for that, and this file is all three.
--
--   1. A CONVERSATION CAN NOW BELONG TO SEVERAL ADDRESSES. Merging marcus@'s
--      thread into hi@'s used to mean marcus@ lost sight of it, because the
--      guest list is per address (D16) and a thread had exactly one. It now
--      carries a list, and everybody who can read ANY address on that list can
--      read the merged conversation. That WIDENS who can see the merged half -
--      deliberately, because a merge is somebody saying out loud that these
--      people are all on the same conversation, and a merged thread half the
--      participants cannot open is not one conversation. The screen that does
--      the merging says so in as many words before it happens.
--
--   2. THE MERGE HAS TO SURVIVE THE NEXT REPLY. Without this the sweep would
--      look for marcus@'s side of the next internal email, find none - it was
--      merged away - and start a fresh one, so the merge would quietly come
--      apart the first time anybody answered. The address list above is what
--      the threading rules read, so the next reply lands on the merged
--      conversation for every side of it.
--
--   3. IT HAS TO BE POSSIBLE TO PUT BACK. Merging two different customers by
--      mistake is a real morning, and "restore last night's backup" is not an
--      answer to it. The losing conversation is KEPT rather than deleted, every
--      message that moved remembers where it came from, and undoing walks both
--      back.
--
-- Idempotent throughout: every statement is guarded, so an install that picks
-- this file up twice is unharmed. No dollar-quoted blocks anywhere, comments
-- included - the backup round-trip harness skips any module whose migrations
-- contain one, and a skipped module is a green gate that proved nothing.
--
-- Column types stay inside the set the core backup serialiser already has a
-- branch for: TEXT, JSONB, TIMESTAMP(3).

-- ---------------------------------------------------------------------------
-- 1. The losing conversation, kept.
-- ---------------------------------------------------------------------------

-- Set on the conversation that lost a merge, exactly as `merged_into_id` is set
-- on a person who lost one. The row survives so that undoing a merge is an
-- update rather than an act of memory, and every list, count and tally hides
-- it. It keeps its own person, its own inbox and its own dates: nothing about
-- it is edited beyond this column, so putting it back needs no reconstruction.
ALTER TABLE "uin_threads" ADD COLUMN IF NOT EXISTS "merged_into_id" TEXT;

ALTER TABLE "uin_threads" DROP CONSTRAINT IF EXISTS "uin_threads_merged_into_fk";
ALTER TABLE "uin_threads" ADD CONSTRAINT "uin_threads_merged_into_fk"
    FOREIGN KEY ("merged_into_id") REFERENCES "uin_threads" ("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "uin_threads_merged_into_idx"
    ON "uin_threads" ("merged_into_id") WHERE "merged_into_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Where a message came from.
-- ---------------------------------------------------------------------------

-- Stamped on every message and draft a merge MOVES, and null on everything
-- else. It does two jobs, and the second is the one worth having.
--
-- Undo reads it to walk exactly what moved back, and only that: a reply that
-- arrived after the merge belongs to the merged conversation and stays there,
-- the same rule person merges already follow.
--
-- Erasure reads it because otherwise a merge would quietly punch a hole in the
-- right to be forgotten. Erasing somebody deletes the conversations that are
-- theirs; a message of theirs that a merge moved onto SOMEBODY ELSE'S
-- conversation is no longer on one of theirs, and without this column it would
-- survive the erasure and sit there being readable. It is not an academic case:
-- merging is exactly what happens when two people turn out to be on one thread.
ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "merged_from_thread_id" TEXT;
ALTER TABLE "uin_drafts"   ADD COLUMN IF NOT EXISTS "merged_from_thread_id" TEXT;

ALTER TABLE "uin_messages" DROP CONSTRAINT IF EXISTS "uin_messages_merged_from_fk";
ALTER TABLE "uin_messages" ADD CONSTRAINT "uin_messages_merged_from_fk"
    FOREIGN KEY ("merged_from_thread_id") REFERENCES "uin_threads" ("id") ON DELETE SET NULL;

ALTER TABLE "uin_drafts" DROP CONSTRAINT IF EXISTS "uin_drafts_merged_from_fk";
ALTER TABLE "uin_drafts" ADD CONSTRAINT "uin_drafts_merged_from_fk"
    FOREIGN KEY ("merged_from_thread_id") REFERENCES "uin_threads" ("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "uin_messages_merged_from_idx"
    ON "uin_messages" ("merged_from_thread_id") WHERE "merged_from_thread_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "uin_drafts_merged_from_idx"
    ON "uin_drafts" ("merged_from_thread_id") WHERE "merged_from_thread_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. The addresses a conversation belongs to.
-- ---------------------------------------------------------------------------

-- Empty for every conversation that has never been merged, which is almost all
-- of them: an ordinary thread belongs to the one address in its own inbox_id
-- and this table has nothing to say about it. A merge writes one row per
-- address involved INCLUDING the winner's own, so the rule downstream is simply
-- "rows here if there are any, inbox_id if there are not" rather than a union
-- of the two that would have to dodge duplicates.
--
-- ON DELETE CASCADE both ways. An address that is deleted stops being one of
-- the addresses a conversation belongs to, and the conversation falls back to
-- whatever is left - which is the same answer the threads table already gives
-- by setting inbox_id to null.
CREATE TABLE IF NOT EXISTS "uin_thread_inboxes" (
    "thread_id"  TEXT         NOT NULL,
    "inbox_id"   TEXT         NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_thread_inboxes_pkey" PRIMARY KEY ("thread_id", "inbox_id"),
    CONSTRAINT "uin_thread_inboxes_thread_fk"
        FOREIGN KEY ("thread_id") REFERENCES "uin_threads" ("id") ON DELETE CASCADE,
    CONSTRAINT "uin_thread_inboxes_inbox_fk"
        FOREIGN KEY ("inbox_id") REFERENCES "uin_inboxes" ("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "uin_thread_inboxes_inbox_idx" ON "uin_thread_inboxes" ("inbox_id");

-- ---------------------------------------------------------------------------
-- 4. What a merge did, so it can be undone.
-- ---------------------------------------------------------------------------

-- One row per losing conversation, so merging four at once is four rows and
-- they can be put back one at a time or all of them.
--
-- No foreign keys out to the conversations, on purpose and for the same reason
-- `uin_person_merges` has none: the retention sweep deletes old conversations,
-- and a record of what somebody did last March should not vanish because the
-- mail it was about aged out. A merge whose conversations have gone simply
-- stops being undoable, which is what `undone_at` and the missing rows already
-- say.
--
-- The snapshot holds ids and the losing conversation's own columns. No bodies,
-- no addresses, nothing that would make this table worth reading for its
-- contents rather than for its record of who did what.
CREATE TABLE IF NOT EXISTS "uin_thread_merges" (
    "id"         TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "winner_id"  TEXT         NOT NULL,
    "loser_id"   TEXT         NOT NULL,
    "user_id"    TEXT,
    "snapshot"   JSONB        NOT NULL DEFAULT '{}',
    "undone_at"  TIMESTAMP(3),
    "undone_by"  TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_thread_merges_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "uin_thread_merges_winner_idx" ON "uin_thread_merges" ("winner_id");
CREATE INDEX IF NOT EXISTS "uin_thread_merges_loser_idx" ON "uin_thread_merges" ("loser_id");

-- ---------------------------------------------------------------------------
-- 5. The audit trail learns the word.
-- ---------------------------------------------------------------------------

-- 'merged' was already a permitted event kind on the people side and there is
-- no CHECK constraint on uin_events.kind to widen, so nothing to do here beyond
-- saying that a thread merge writes one against the WINNING conversation - the
-- one that still exists to be looked at a fortnight later.
