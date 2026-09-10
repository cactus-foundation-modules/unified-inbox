-- Unified Inbox - Migration 052: a bin, and the one thing on this screen that
-- genuinely throws something away.
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
-- THIS IS THE JUNK TABLE AGAIN, DELIBERATELY, AND THEN IT IS NOT.
--
-- The shape is a copy of "uin_thread_spam" and that is on purpose. Deleting a
-- conversation is the same KIND of fact as calling one junk: it is one person's
-- decision about one conversation, not a fact about the mail. The supplier
-- newsletter one colleague deletes is the one another reads every Tuesday, and
-- a shared address has several people in it - so it is a row per
-- (conversation, person), and deleting something takes it off YOUR lists and
-- leaves everybody else's exactly as they were. Whose bin it lands in follows
-- the same rule junk follows: post in a colleague's OWN address is theirs, so
-- somebody covering Sam while Sam is away fills Sam's bin rather than their own
-- (see binOwnerFor in lib/bin.ts, which is spamOwnerFor - one rule, one
-- implementation, because two copies of it would drift and half the module
-- would then disagree with the other half about where a message went).
--
-- WHERE THE TWO PART COMPANY is what happens next, and it is worth being blunt
-- about because nothing else in this module does it.
--
--   Junk is refused. Nothing is destroyed, ever: a conversation in the Spam
--   folder keeps every message in it and comes back the moment somebody presses
--   the button again.
--
--   The bin is refused AND, eventually, destroyed - but only ever by somebody
--   pressing "Empty bin" and agreeing to a question that says so in plain
--   English. There is NO timer. Nothing in here empties itself after thirty
--   days, because a conversation quietly disappearing on a date nobody chose is
--   the failure mode that makes people distrust a bin and stop using it. Until
--   that button is pressed, a row here hides a conversation and does nothing
--   else at all, and pressing the bin button again in the Bin folder puts it
--   straight back.
--
-- AND NOTHING HERE EVER TOUCHES A MAIL SERVER. Deleting a conversation on this
-- site deletes it on this site. The message stays exactly where it is in
-- whatever mailbox it was collected from, untouched, as does every other
-- message this module has ever read - the only thing this module has ever
-- written to anybody's mailbox is a copy of a reply, filed in Sent. Emptying
-- the bin removes rows from this database and the attachments those rows point
-- at from this site's own storage. It does not, and must never, issue a
-- delete to IMAP.
--
-- There is deliberately no site-wide stamp beside this, the way "blocked_at"
-- sits beside the junk marks. Nothing arrives pre-deleted: a bin holds what
-- somebody put in it, and a conversation nobody chose to throw away has no
-- business being in one.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- One person's bin.
--
-- The pair is the key: a conversation is either in your bin or it is not, and
-- pressing the button twice is not two decisions. `created_at` is what the Bin
-- folder is ordered by - what you threw away most recently is what you are most
-- likely to have thrown away by mistake, and that is the row worth having at
-- the top.
--
-- CASCADE on both sides, for the two different reasons the junk table gives. A
-- conversation that has gone takes its bin marks with it, because there is
-- nothing left to have thrown away - which is also what makes "Empty bin" a
-- single DELETE on the conversations rather than a two-step tidy-up. A
-- colleague who has left takes theirs, because the decision belonged to the
-- person who made it and there is nobody to ask any more - and, more to the
-- point, nobody whose lists it could still be hiding things from.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "uin_thread_bin" (
    "thread_id"  TEXT         NOT NULL,
    "user_id"    TEXT         NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_thread_bin_pkey" PRIMARY KEY ("thread_id", "user_id"),
    CONSTRAINT "uin_thread_bin_thread_fk"
        FOREIGN KEY ("thread_id") REFERENCES "uin_threads" ("id") ON DELETE CASCADE,
    CONSTRAINT "uin_thread_bin_user_fk"
        FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE
);

-- The Bin folder itself: one person's marks, newest first.
CREATE INDEX IF NOT EXISTS "uin_thread_bin_user_idx"
    ON "uin_thread_bin" ("user_id", "created_at" DESC);

-- The other direction, which is the one every ordinary list runs. Every
-- conversation list in the module now carries "and nobody whose bin this
-- belongs in has thrown it away", asked as a NOT EXISTS on
-- (thread_id, user_id) - which the primary key above already answers. Named
-- here anyway so that whoever reads this file knows the hot path was thought
-- about rather than hoped for.
CREATE INDEX IF NOT EXISTS "uin_thread_bin_thread_idx"
    ON "uin_thread_bin" ("thread_id");
