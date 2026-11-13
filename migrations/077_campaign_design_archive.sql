-- ---------------------------------------------------------------------------
-- Campaigns: a designed message, the site's email design around it, and
-- somewhere to put a finished campaign that is not the list of live ones.
--
--   uin_campaigns.use_wrapper / wrapper_layout_id - send it inside one of the
--   site's own email designs (core's `emailWrapper` layouts). Off by default:
--   a campaign that reads like a person wrote it is still the standing advice,
--   and an owner who wants the branded card asks for it. A null layout id with
--   the switch on means "whichever design the site treats as its default", and
--   a layout that is later deleted falls back to that rather than taking the
--   campaign down with it.
--
--   uin_campaigns.archived_at - a finished or stopped campaign put away. Only
--   ever hides it from the main list; the record of who got it, who read it and
--   who unsubscribed stays exactly as it was.
--
--   uin_campaign_steps.body_design - the message built with the email blocks in
--   the pop-out designer, as the designer's own document. Null for a message
--   typed in the plain box, which is every campaign written before this file.
--   When set, `body` holds the plain-text reading of it, so the checks that
--   read the words (unknown merge tags, an empty message) keep working on it.
--
-- Idempotent throughout, and no dollar-quoted blocks anywhere in this file -
-- the backup round-trip harness skips any module whose migrations carry them.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_campaigns" ADD COLUMN IF NOT EXISTS "use_wrapper" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "uin_campaigns" ADD COLUMN IF NOT EXISTS "wrapper_layout_id" TEXT;
ALTER TABLE "uin_campaigns" ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "uin_campaigns_archived_idx"
    ON "uin_campaigns" ("archived_at")
 WHERE "archived_at" IS NOT NULL;

ALTER TABLE "uin_campaign_steps" ADD COLUMN IF NOT EXISTS "body_design" JSONB;
