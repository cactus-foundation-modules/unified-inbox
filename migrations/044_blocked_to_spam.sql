-- Unified Inbox - Migration 044: post from a blocked sender lands in the bin.
--
-- A NEW numbered file rather than an edit to 041, because a module migration is
-- recorded once per install and never runs again: editing 041 would reach a
-- fresh install and nobody else. Idempotent, no dollar-quoting anywhere -
-- comments included - because the backup round-trip harness skips a whole
-- module whose migration files carry a pair of them, which buys a green gate
-- that proved nothing. TIMESTAMP(3), which this module already stores in a
-- dozen places, so the backup serialiser and its schema-coverage backstop need
-- no new branch.
--
-- ---------------------------------------------------------------------------
-- WHAT CHANGED, AND WHY IT NEEDED A COLUMN.
--
-- Blocking somebody used to mean their mail was never collected at all: the
-- collecting pass read the headers, recognised the address, wrote down that it
-- had walked past that spot, and left the message on the mail server. Tidy, and
-- wrong in the one way that matters - "did they ever actually write?" then had
-- no answer anywhere on this site, and the person asking had to go and log into
-- a mailbox to find out. A blocked sender is usually a nuisance, occasionally a
-- customer somebody blocked in a temper, and the difference only shows up
-- weeks later.
--
-- So it is collected now, and it goes straight into the bin: in the Spam
-- folder, marked done so it is out of everybody's way, and left UNREAD so the
-- folder can say how much of it there is. Nothing is deleted; nothing reaches
-- an ordinary list.
--
-- WHICH IS A SITE-WIDE FACT, and that is the whole reason this is a column on
-- the conversation rather than a row in "uin_thread_spam". That table holds one
-- PERSON'S opinion of one conversation, deliberately - the newsletter one
-- colleague bins is the one another reads every Tuesday. A block is not an
-- opinion: it is one list for the whole site, applied at the door, and post
-- turned away by it has to be out of EVERYBODY'S lists rather than out of
-- whichever colleague's the collecting pass happened to guess at. There is no
-- person to guess at, either: nobody pressed anything, and the colleague who
-- blocked the address six months ago may since have left.
--
-- So: a stamp on the conversation, and the two junk clauses in lib/db.ts read
-- it beside the per-person marks. Hidden from every list for everybody, listed
-- in the Spam folder for anybody who can see the conversation at all.
--
-- CLEARED BY "Not junk", which is the only way out. Pressing it on one of these
-- takes the site-wide stamp off as well as the presser's own mark - otherwise a
-- conversation could go into the bin and never come out of it, which is exactly
-- the trap a spam folder must not have. The sender stays blocked either way:
-- letting one conversation through is not the same decision as opening the
-- front door, and they are two different buttons in two different places.
-- ---------------------------------------------------------------------------

-- NULL on every conversation that got here the ordinary way, which is nearly
-- all of them. Non-null is "the site refused this sender and filed it anyway",
-- and it doubles as when that happened.
ALTER TABLE "uin_threads"
    ADD COLUMN IF NOT EXISTS "blocked_at" TIMESTAMP(3);

-- Partial, so it costs a fresh install nothing and a busy site almost nothing:
-- the rows in it are the ones the site turned away, which on any healthy
-- mailbox is a rounding error against the post. It answers the Spam folder's
-- half of the junk clause - "or the site blocked this one" - without making the
-- ordinary lists, which ask for the NULLs, pay for an index they cannot use.
CREATE INDEX IF NOT EXISTS "uin_threads_blocked_idx"
    ON "uin_threads" ("blocked_at" DESC)
    WHERE "blocked_at" IS NOT NULL;
