-- Unified Inbox - Migration 041: junk, and the senders who send it.
--
-- A NEW numbered file rather than an edit to an earlier one: a module migration
-- is recorded once per install and never runs again, so editing an earlier one
-- would reach a fresh install and nobody else. Everything below is idempotent,
-- and there is no dollar-quoting anywhere - comments included - because the
-- backup round-trip harness skips a whole module whose migration files carry a
-- pair of them, which buys a green gate that proved nothing.
--
-- TEXT and TIMESTAMP(3) only, both of which this module already stores in a
-- dozen places, so the backup serialiser and its schema-coverage backstop need
-- no new branch.
--
-- ---------------------------------------------------------------------------
-- TWO DIFFERENT DECISIONS, AND THEY ARE DELIBERATELY NOT THE SAME TABLE.
--
--   "This is junk"      is one person's opinion about one conversation. It is
--                       not a fact about the mail, it is a fact about who is
--                       reading it: the newsletter one colleague files as junk
--                       is the newsletter another reads every Tuesday, and a
--                       shared address has several people in it. So it is a row
--                       per (conversation, person), and marking something junk
--                       takes it off YOUR lists and leaves everybody else's
--                       exactly as they were.
--
--   "Never let this     is a decision about the site. Somebody blocked is
--    sender in again"   blocked at the door, before anything is filed, so they
--                       reach no inbox at all - not the shared ones, not the
--                       individual ones, not the one address nobody has opened
--                       since March. One list for the whole site, because a
--                       block that only covered the address you happened to be
--                       standing in is not a block.
--
-- Which is why the second one is offered rather than assumed. Marking a
-- conversation as junk asks whether to block the sender as well; answering no
-- is the ordinary answer and leaves the site's front door where it was.
--
-- NEITHER OF THEM DELETES ANYTHING. A conversation marked as junk keeps every
-- message in it and can be taken back out again. Mail from a blocked sender is
-- simply not collected - it stays on the mail server, where the account's owner
-- can still see it in whatever their mail app calls its own junk folder. This
-- module has never written to anybody's mailbox except to file a copy of a
-- reply in Sent, and blocking somebody does not change that.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- One person's junk.
--
-- The pair is the key: a conversation is either junk to you or it is not, and
-- pressing the button twice is not two opinions. `created_at` is what the Spam
-- folder is ordered by - what you threw away most recently is what you are most
-- likely to have thrown away by mistake, and that is the row worth having at
-- the top.
--
-- CASCADE on both sides, and for two different reasons. A conversation that has
-- gone takes its junk marks with it, because there is nothing left to have an
-- opinion about. A colleague who has left takes theirs, because an opinion
-- belongs to the person who held it and there is nobody to ask any more - and,
-- more to the point, nobody whose lists it could still be hiding things from.
-- Every other staff-account reference in this module is SET NULL, which is the
-- right answer where a row survives its person; here the row IS the person's.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "uin_thread_spam" (
    "thread_id"  TEXT         NOT NULL,
    "user_id"    TEXT         NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_thread_spam_pkey" PRIMARY KEY ("thread_id", "user_id"),
    CONSTRAINT "uin_thread_spam_thread_fk"
        FOREIGN KEY ("thread_id") REFERENCES "uin_threads" ("id") ON DELETE CASCADE,
    CONSTRAINT "uin_thread_spam_user_fk"
        FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE
);

-- The Spam folder itself: one person's marks, newest first.
CREATE INDEX IF NOT EXISTS "uin_thread_spam_user_idx"
    ON "uin_thread_spam" ("user_id", "created_at" DESC);

-- The other direction, which is the one every ordinary list runs. Every
-- conversation list in the module now carries "and this reader has not marked
-- it as junk", asked as a NOT EXISTS on (thread_id, user_id) - which the
-- primary key above already answers. Named here anyway so that whoever reads
-- this file knows the hot path was thought about rather than hoped for.
CREATE INDEX IF NOT EXISTS "uin_thread_spam_thread_idx"
    ON "uin_thread_spam" ("thread_id");

-- ---------------------------------------------------------------------------
-- The site's front door.
--
-- The address is the key, normalised the way every other address in this module
-- is normalised before it is stored (see lib/addresses.ts): lower case, spaces
-- off both ends. Comparing what arrived against what was blocked is then a
-- string comparison rather than a guess, and "Sales@Example.COM " cannot get in
-- past a block on "sales@example.com".
--
-- No foreign key on the address to anything: a blocked sender is usually
-- somebody the site has no record of at all, and would very much like to keep
-- having no record of.
--
-- Who blocked them is kept because "why can this customer not get through to
-- us" is the question asked six months later by somebody who was not there, and
-- a bare list of addresses cannot answer it. SET NULL rather than CASCADE: the
-- colleague who blocked a spammer leaving the company is not a reason to let
-- the spammer back in.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "uin_blocked_senders" (
    "id"                 TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "address"            TEXT         NOT NULL,
    "blocked_by_user_id" TEXT,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_blocked_senders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uin_blocked_senders_user_fk"
        FOREIGN KEY ("blocked_by_user_id") REFERENCES "User" ("id") ON DELETE SET NULL
);

-- One row per address, so blocking somebody twice is blocking them once. The
-- collecting pass reads this whole table into a set once per run and asks it in
-- memory, so this index is for the write rather than the read.
CREATE UNIQUE INDEX IF NOT EXISTS "uin_blocked_senders_address_key"
    ON "uin_blocked_senders" ("address");
