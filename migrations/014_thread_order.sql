-- Unified Inbox - Migration 014: which end of a conversation opens first.
--
-- A NEW numbered file rather than an edit to an earlier one: a module migration
-- is recorded once per install and never runs again, so editing 001 reaches a
-- fresh install and nobody else. Everything below is idempotent, and there is
-- no dollar-quoting anywhere - comments included - because the backup
-- round-trip harness skips a whole module whose migration files carry a pair of
-- them, which buys a green gate that proved nothing.
--
-- BOOLEAN is already stored by this module, so the schema-coverage backstop
-- needs no new branch.

-- Off by default, which is the order every install reads in today: oldest at
-- the top, the way the conversation actually happened. On, the newest message
-- sits at the top and the writing box goes with it, for somebody who opens a
-- long thread to read the last thing said rather than the first.
ALTER TABLE "uin_settings" ADD COLUMN IF NOT EXISTS "newest_first" BOOLEAN NOT NULL DEFAULT false;
