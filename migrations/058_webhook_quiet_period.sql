-- Unified Inbox - Migration 058: a quiet period after each note a subscription sends.
--
-- A NEW numbered file rather than an edit to 008: a module migration is
-- recorded once per install and never runs again. Idempotent, and no
-- dollar-quoting anywhere - comments included - because the backup round-trip
-- harness skips a whole module whose migration files carry a pair of them.
--
-- INTEGER and TIMESTAMP(3) only, both already stored by this module, so the
-- backup serialiser needs no new branch.
--
-- WHAT THIS IS FOR. An automation told about new post usually goes and deals
-- with the whole inbox, not just the one message it was told about. Everything
-- that arrives while it is doing so - the next email, a hand-over, a tag - set
-- it off again, one run after another. So a subscription that has just queued a
-- note stays quiet for a while, and anything in that window is not sent at all:
-- the automation that is already running will find it.
--
--   quiet_minutes   how long, per subscription. 10 by default, existing
--                   subscriptions included - which is the point of the change.
--                   0 switches it off.
--   last_queued_at  when it last queued one. Claimed in the same statement
--                   that queues the note (lib/webhooks-db.ts), so two mail
--                   checks racing cannot both get through the window.

ALTER TABLE "uin_webhooks" ADD COLUMN IF NOT EXISTS "quiet_minutes"  INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "uin_webhooks" ADD COLUMN IF NOT EXISTS "last_queued_at" TIMESTAMP(3);

ALTER TABLE "uin_webhooks" DROP CONSTRAINT IF EXISTS "uin_webhooks_quiet_minutes_check";
ALTER TABLE "uin_webhooks"
    ADD CONSTRAINT "uin_webhooks_quiet_minutes_check"
    CHECK ("quiet_minutes" BETWEEN 0 AND 1440);
