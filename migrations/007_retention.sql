-- Unified Inbox - keeping it liveable: retention, erasure and housekeeping (S8)
--
-- A NEW numbered file rather than an edit to an earlier one: a module migration
-- is recorded once per install and never runs again, so editing 001 reaches a
-- fresh install and nobody else. Everything below is idempotent.
--
-- Two harness rules this module has already paid for once each, both tripped
-- from inside a COMMENT rather than from any SQL:
--
--   No dollar-quoting anywhere in the file, comments included. The backup
--   round-trip skips a whole module whose migrations contain one, which buys a
--   green gate that never checked the thing it was supposed to be checking.
--
--   In a file that adds no new table, the phrase for making one must not appear
--   at all - the schema-coverage test flags any migration that mentions it but
--   yields no parsed column, as drift detection for its own regex.
--
-- This file adds two settings columns and three indexes. No new table, no new
-- column type, and deliberately no sequence anywhere in this module: a sequence
-- is invisible to information_schema.tables and a backup that misses one hands
-- a restored site a counter that starts again from the beginning.

-- ---------------------------------------------------------------------------
-- Retention.
--
-- Deleting somebody's mail is the one operation here that cannot be undone by
-- pressing the other button, so the setting that governs it is the cautious one
-- by default. A conversation carrying an order, a purchase order or a quote is
-- part of the story of that record, and the person who set a twelve month
-- window was thinking about mailing lists rather than about the invoice dispute
-- from eighteen months ago. So: keep the linked ones unless somebody says
-- otherwise, in so many words, on a screen that tells them how many that is.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_settings"
    ADD COLUMN IF NOT EXISTS "retention_keep_linked" BOOLEAN NOT NULL DEFAULT true;

-- When the sweep last finished a pass, so the settings screen can say so rather
-- than leaving the owner to wonder whether anything is happening at all.
ALTER TABLE "uin_settings"
    ADD COLUMN IF NOT EXISTS "retention_last_run_at" TIMESTAMP(3);

-- No index is added here, and that is a finding rather than an omission. The
-- three the sweep and the erase want already exist: uin_threads_last_message_idx
-- is read backwards for the oldest conversations, uin_record_links_thread_idx
-- answers "does this one carry a link", and uin_threads_person_idx walks one
-- person's conversations. Adding a partial copy of an index that is already
-- there under the same name is a no-op that reads like work.
