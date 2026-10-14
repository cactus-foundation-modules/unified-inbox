-- Unified Inbox - Migration 076: the title on a campaign recipient.
--
-- A NEW numbered file. Idempotent, no dollar-quoted blocks, one text column.
--
-- Recipients carry a copy of the name fields their message is personalised
-- from (see 027), never read back through to the address book, so the new
-- {{title}} merge tag needs its own copy. Rows made before this file have none,
-- which the tag treats as "nothing to put here" and falls back.

ALTER TABLE "uin_campaign_recipients" ADD COLUMN IF NOT EXISTS "title" TEXT;
