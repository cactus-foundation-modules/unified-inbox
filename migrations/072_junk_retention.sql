-- How long a conversation may sit in the junk folder before the nightly tidy
-- removes it.
--
-- Whole days, and 30 by default: junk is the one folder nobody wants to keep,
-- and a month is long enough to notice that something real was filed there by
-- mistake. NULL switches the clean-up off, which is what clearing the box on
-- the settings screen writes. Existing sites pick up the 30 as well - the column
-- default fills the singleton row - which is the point of it being a default.
-- ---------------------------------------------------------------------------
ALTER TABLE "uin_settings"
    ADD COLUMN IF NOT EXISTS "junk_retention_days" INTEGER DEFAULT 30;

ALTER TABLE "uin_settings" DROP CONSTRAINT IF EXISTS "uin_settings_junk_retention_check";
ALTER TABLE "uin_settings" ADD CONSTRAINT "uin_settings_junk_retention_check"
    CHECK ("junk_retention_days" IS NULL OR ("junk_retention_days" >= 1 AND "junk_retention_days" <= 365));
