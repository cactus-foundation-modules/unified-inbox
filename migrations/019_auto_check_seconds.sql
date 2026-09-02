-- Unified Inbox - Migration 019: checking for new mail while somebody is
-- looking at the inbox.
--
-- A NEW numbered file rather than an edit to an earlier one: a module migration
-- is recorded once per install and never runs again, so editing 001 reaches a
-- fresh install and nobody else. Everything below is idempotent, and there is
-- no dollar-quoting anywhere - comments included - because the backup
-- round-trip harness skips a whole module whose migration files carry a pair of
-- them, which buys a green gate that proved nothing.
--
-- INTEGER is already stored by this module (retention_months), so the
-- schema-coverage backstop needs no new branch.

-- NULL means off: mail is collected on the site's schedule and by the Check now
-- button, exactly as before. A number is how many seconds to leave between
-- checks while an inbox page is open and in front of somebody. Nothing runs in
-- a tab nobody is looking at, and nothing runs anywhere else on the site.
ALTER TABLE "uin_settings" ADD COLUMN IF NOT EXISTS "auto_check_seconds" INTEGER;
