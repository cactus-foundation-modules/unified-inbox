-- Unified Inbox - Migration 023: a chase may be sooner than a day.
--
-- A NEW numbered file rather than an edit to 022: an applied module migration
-- is recorded once and never runs again, so editing 022 would reach a fresh
-- install and nobody else. Idempotent, and no dollar quoting anywhere -
-- comments included - for the reason 021 and 022 both give.
--
-- ---------------------------------------------------------------------------
-- 022 put the floor at a day, on the reasoning that a conversation coming back
-- before the recipient has opened their mail teaches people to ignore it. That
-- was a guess about how long is worth waiting, made in the wrong place: the
-- follow-up now offers exactly the answers putting a conversation to sleep
-- offers - three hours, tomorrow morning, next week, or a day and a time of
-- your own - and "in three hours" is three hours whatever this column thinks.
--
-- So the floor becomes the only thing a floor is actually for: keeping the
-- chase on the far side of the send. Five minutes, and everything above it is
-- somebody else's judgement.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_drafts" DROP CONSTRAINT IF EXISTS "uin_drafts_follow_up_check";
ALTER TABLE "uin_drafts" ADD CONSTRAINT "uin_drafts_follow_up_check"
    CHECK ("follow_up_minutes" IS NULL
           OR ("follow_up_minutes" >= 5 AND "follow_up_minutes" <= 527040));
