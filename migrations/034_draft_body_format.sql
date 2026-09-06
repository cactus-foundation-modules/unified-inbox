-- Unified Inbox - Migration 034: a draft that knows what it is written in.
--
-- A NEW numbered file rather than an edit to an earlier one: a module migration
-- is recorded once per install and never runs again, so editing 013 would reach
-- a fresh install and nobody else. Every statement below is idempotent, and
-- there is no dollar-quoting anywhere - comments included - because the backup
-- round-trip harness skips a whole module whose migration files carry a pair of
-- them, which buys a green gate that proved nothing.
--
-- The column is TEXT, which this module already stores everywhere, so the
-- schema-coverage backstop needs no new branch.
--
-- ---------------------------------------------------------------------------
-- What this is for.
--
-- Both writing boxes can hold bold, italic, a colour, a link and a list now, so
-- what somebody types is markup rather than lines of text. The body column has
-- always been "as typed", and it still is - what changed is that "as typed" can
-- now mean two different things, and everything that reads the column has to
-- know which:
--
--   the composer, which either drops the markup straight back into the box or
--   turns the old line breaks into it first;
--   the scheduled sender, which either sends the markup as it stands or escapes
--   the text and turns its newlines into breaks;
--   the drafts list and the read-only view, which flatten one and print the
--   other.
--
-- Guessing from the content - "does it contain an angle bracket" - is how a
-- reply that mentions "a < b" ends up rendered as broken markup, and how a
-- pasted line of HTML ends up sent as live markup nobody meant to send. So the
-- row says which it is.
--
-- 'text' is the default, because that is what every draft written before this
-- migration is, and there is no rewriting them: an old draft opens in the new
-- box with its line breaks intact and is saved back as markup the first time
-- anybody touches it.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_drafts"
    ADD COLUMN IF NOT EXISTS "body_format" TEXT NOT NULL DEFAULT 'text';

-- Dropped and re-added rather than guarded by a DO block, which would need
-- dollar quoting. Both halves are idempotent on their own.
ALTER TABLE "uin_drafts" DROP CONSTRAINT IF EXISTS "uin_drafts_body_format_check";
ALTER TABLE "uin_drafts" ADD CONSTRAINT "uin_drafts_body_format_check"
    CHECK ("body_format" IN ('text', 'html'));
