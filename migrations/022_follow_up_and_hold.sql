-- Unified Inbox - Migration 022: chasing it up, and standing it down.
--
-- A NEW numbered file rather than an edit to an earlier one: a module migration
-- is recorded once per install and never runs again, so editing 021 would reach
-- a fresh install and nobody else. Everything below is idempotent, and there is
-- no dollar-quoting anywhere - comments included - because the backup
-- round-trip harness skips a whole module whose migration files carry a pair of
-- them, which buys a green gate that proved nothing.
--
-- Every column here is INTEGER, TEXT or TIMESTAMP(3), all of which the backup
-- serialiser already has a branch for, so the schema-coverage backstop needs no
-- new one.
--
-- ---------------------------------------------------------------------------
-- Two halves of the same evening.
--
-- Somebody writes to a supplier at eleven at night and sets it to go out at
-- nine. Two things are true about that message that nothing in the module could
-- say until now.
--
-- THE FIRST: they will want to know if it is ignored. Today the only way to
-- chase it is to remember to, and remembering is what people are worst at. So a
-- scheduled message may carry a follow-up: once it has actually gone, the
-- conversation is snoozed for that long, and it comes back on its own if nobody
-- has answered. A reply already cancels a snooze (see reopenOnReply), so the
-- chase disappears the moment it is not needed - which is the whole reason the
-- follow-up is expressed as a snooze rather than as a reminder of its own.
--
--   follow_up_minutes  how long after it goes out to bring the conversation
--                      back. NULL is no follow-up, which is what every draft on
--                      every existing install already has.
--
-- THE SECOND: the supplier might write first. A message set for nine on Monday
-- is a message written without Monday's post in front of you, and sending it
-- anyway is how you ask a question that has already been answered. So mail
-- arriving from somebody a scheduled message is addressed to STANDS THAT
-- MESSAGE DOWN: it stops being queued, the writing stays exactly as it was, and
-- the conversation that arrived says so. The time it was set for is kept, with
-- no state beside it, so the screen can say what it was going to do rather than
-- only that it is not doing it - and a time with no state is an ordinary draft
-- to every query this module has.
--
--   held_by_thread_id  the conversation whose arrival stood it down, so the
--                      warning can be shown on that conversation and nowhere
--                      else. ON DELETE SET NULL, because a conversation being
--                      removed must never take somebody's unsent writing with
--                      it - it only costs the warning.
--   held_at            when that happened.
--
-- Held is deliberately not a fourth send_state. A stood-down message is an
-- ordinary draft again in every way that matters - nothing collects it, nothing
-- is waiting on it, and anybody who may finish it may send it now - and the two
-- columns are the note explaining why it stopped being scheduled, not a state
-- the queue has to learn.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_drafts" ADD COLUMN IF NOT EXISTS "follow_up_minutes" INTEGER;
ALTER TABLE "uin_drafts" ADD COLUMN IF NOT EXISTS "held_by_thread_id"  TEXT;
ALTER TABLE "uin_drafts" ADD COLUMN IF NOT EXISTS "held_at"            TIMESTAMP(3);

-- Dropped and re-added rather than guarded by a DO block, which would need
-- dollar quoting. Both halves are idempotent on their own.
--
-- A day at the bottom end, because a follow-up measured in minutes is a
-- conversation that comes back before the recipient has opened their mail; a
-- year at the top, matching how far ahead a message may be scheduled at all.
ALTER TABLE "uin_drafts" DROP CONSTRAINT IF EXISTS "uin_drafts_follow_up_check";
ALTER TABLE "uin_drafts" ADD CONSTRAINT "uin_drafts_follow_up_check"
    CHECK ("follow_up_minutes" IS NULL
           OR ("follow_up_minutes" >= 60 AND "follow_up_minutes" <= 527040));

ALTER TABLE "uin_drafts" DROP CONSTRAINT IF EXISTS "uin_drafts_held_thread_fk";
ALTER TABLE "uin_drafts" ADD CONSTRAINT "uin_drafts_held_thread_fk"
    FOREIGN KEY ("held_by_thread_id") REFERENCES "uin_threads" ("id") ON DELETE SET NULL;

-- What the conversation screen asks on the way in: is anything being held
-- because of this one. Partial, because the answer is almost always none and
-- the index should be the size of the answer rather than the size of the table.
CREATE INDEX IF NOT EXISTS "uin_drafts_held_idx"
    ON "uin_drafts" ("held_by_thread_id")
    WHERE "held_by_thread_id" IS NOT NULL;

-- Nothing is indexed for the other direction - "which scheduled messages are
-- addressed to this person" - deliberately. The match is made without regard to
-- case, which no index on the array itself can serve, and the rows it runs over
-- are the scheduled ones only: a handful on any site that has ever existed.
