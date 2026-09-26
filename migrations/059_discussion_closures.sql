-- Unified Inbox - Migration 059: closing or deleting a discussion does it for you.
--
-- A NEW numbered file rather than an edit to an earlier one: a module migration
-- is recorded once per install and never runs again. Idempotent, and no
-- dollar-quoting anywhere - comments included - because the backup round-trip
-- harness skips a whole module whose migration files carry a pair of them.
--
-- TEXT and TIMESTAMP(3) only, both already stored by this module.
--
-- WHAT THIS IS FOR. A conversation's status is one column everybody shares,
-- which is right for post from a customer: one enquiry, answered once, done.
-- It is wrong for an internal discussion. That is several colleagues each with
-- their own part to play, and the first of them to tick it done took it off
-- everybody else's list - including the people still waiting to answer.
--
-- So on a discussion, done is a row here for the person who said so, and the
-- shared status is left alone. Every list works a discussion's status out for
-- whoever is looking: done if they closed it, the shared status otherwise.
-- A new note in the discussion clears everybody's row but its author's, the
-- same way a reply reopens an email.
--
-- Going with the conversation, and with the person: a colleague who leaves
-- takes their closures with them, which reopens nothing for anybody else.
CREATE TABLE IF NOT EXISTS "uin_discussion_closures" (
    "thread_id" TEXT         NOT NULL,
    "user_id"   TEXT         NOT NULL,
    "closed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_discussion_closures_pkey" PRIMARY KEY ("thread_id", "user_id"),
    CONSTRAINT "uin_discussion_closures_thread_fk"
        FOREIGN KEY ("thread_id") REFERENCES "uin_threads" ("id") ON DELETE CASCADE,
    CONSTRAINT "uin_discussion_closures_user_fk"
        FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE
);

-- The primary key answers "has this person closed this one", which is the
-- question every list asks per row. This answers the other way round, for
-- tidying up after a person.
CREATE INDEX IF NOT EXISTS "uin_discussion_closures_user_idx"
    ON "uin_discussion_closures" ("user_id");

-- ---------------------------------------------------------------------------
-- DELETING ONE, LIKEWISE.
--
-- Deleting a conversation puts it in a bin, and emptying the bin destroys it -
-- for everybody, which is what an email wants and exactly what a discussion
-- does not: it belongs to every colleague in it, and one of them tidying up
-- must not take it from the others.
--
-- So a discussion always goes into the presser's own bin, only their own bin
-- hides it from them, and emptying the bin does not destroy it. It is stamped
-- here instead: gone from that person's Bin folder, still hidden from every
-- list of theirs, and untouched for everybody else.
-- ---------------------------------------------------------------------------
ALTER TABLE "uin_thread_bin" ADD COLUMN IF NOT EXISTS "purged_at" TIMESTAMP(3);
