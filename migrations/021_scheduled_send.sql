-- Unified Inbox - Migration 021: a message written now and sent later.
--
-- A NEW numbered file rather than an edit to an earlier one: a module migration
-- is recorded once per install and never runs again, so editing 013 would reach
-- a fresh install and nobody else. Everything below is idempotent, and there is
-- no dollar-quoting anywhere - comments included - because the backup
-- round-trip harness skips a whole module whose migration files carry a pair of
-- them, which buys a green gate that proved nothing.
--
-- Every column here is TEXT or TIMESTAMP(3), both of which this module already
-- stores, so the schema-coverage backstop needs no new branch.
--
-- ---------------------------------------------------------------------------
-- What this is for.
--
-- Somebody answers a supplier at half past eleven at night and would rather the
-- supplier saw it at nine in the morning. Or the quote is written on Friday and
-- ought to land on Monday. Today the only two answers are "send it now" and
-- "remember to send it later", and the second one is not an answer.
--
-- A scheduled message is a DRAFT WITH A DEPARTURE TIME, not a third kind of
-- thing. It is not a message: it has no Message-ID, it is not part of any
-- conversation's story, and nothing that walks the messages table must ever
-- meet it. It is already exactly what a draft is - recipients, a subject, typed
-- text and files that already live in storage - and the only new fact about it
-- is when it should leave. So the columns go here rather than into a table of
-- their own, and every access rule, guest list and tidy-up that already governs
-- a draft governs this too, with nothing to keep in step.
--
--   send_at     when it should go. NULL for an ordinary draft, and NULL is the
--               state every draft on every existing install already has.
--   send_state  'scheduled' - waiting for its time.
--               'sending'   - claimed by a run that is posting it right now.
--               'failed'    - its time came and the mail server refused it. The
--                             writing is still here, with the reason beside it,
--                             which is the whole point of not deleting the row
--                             until the message has genuinely gone.
--   send_error  why, in the sentence the send route already writes for a person
--               to read.
--   claimed_at  when a run took it. What tells a later run that a claim is
--               stale because the function died mid-send, rather than that
--               something is still in flight.
--
-- The claim is what stops one message going twice. Two runs overlapping - a
-- cron tick and somebody pressing Check now - both look for due rows, and the
-- one that loses the UPDATE ... WHERE send_state = 'scheduled' race gets no row
-- back and posts nothing. The send route's own idempotency key is the second
-- belt: the draft's id IS that key, so even a claim that somehow ran twice
-- lands on one message rather than two.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_drafts" ADD COLUMN IF NOT EXISTS "send_at"    TIMESTAMP(3);
ALTER TABLE "uin_drafts" ADD COLUMN IF NOT EXISTS "send_state" TEXT;
ALTER TABLE "uin_drafts" ADD COLUMN IF NOT EXISTS "send_error" TEXT;
ALTER TABLE "uin_drafts" ADD COLUMN IF NOT EXISTS "claimed_at" TIMESTAMP(3);

-- Dropped and re-added rather than guarded by a DO block, which would need
-- dollar quoting. Both halves are idempotent on their own.
ALTER TABLE "uin_drafts" DROP CONSTRAINT IF EXISTS "uin_drafts_send_state_check";
ALTER TABLE "uin_drafts" ADD CONSTRAINT "uin_drafts_send_state_check"
    CHECK ("send_state" IS NULL OR "send_state" IN ('scheduled', 'sending', 'failed'));

-- A state without a time is a message waiting for a moment that will never
-- come, which is worse than an ordinary draft because the screen would say it
-- is going out.
ALTER TABLE "uin_drafts" DROP CONSTRAINT IF EXISTS "uin_drafts_send_at_check";
ALTER TABLE "uin_drafts" ADD CONSTRAINT "uin_drafts_send_at_check"
    CHECK ("send_state" IS NULL OR "send_at" IS NOT NULL);

-- What every run asks: which of these are due. Partial, because on any ordinary
-- site the answer is a handful of rows out of a table of drafts, and the index
-- should be the same size as the answer.
CREATE INDEX IF NOT EXISTS "uin_drafts_due_idx"
    ON "uin_drafts" ("send_at")
    WHERE "send_state" = 'scheduled';

-- Claims that were never settled, for the sweep that puts them back. Same
-- shape, same reason.
CREATE INDEX IF NOT EXISTS "uin_drafts_claimed_idx"
    ON "uin_drafts" ("claimed_at")
    WHERE "send_state" = 'sending';
