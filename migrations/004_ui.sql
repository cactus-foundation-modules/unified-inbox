-- Unified Inbox - reading, searching and working through it (S5)
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
-- This file adds indexes only. No new column, no new type, nothing for the
-- backup serialiser to learn.

-- ---------------------------------------------------------------------------
-- Search.
--
-- One GIN index over the expression rather than a stored column: a generated
-- column would work too (tsvector is in the serialiser's supported set and
-- generated columns are excluded from a dump), but it would widen every message
-- row for a facility only the search box uses, and the expression index is the
-- simpler of the two to keep honest. The query in lib/db.ts must spell the
-- expression EXACTLY as it is written here, down to the order of the fields and
-- the ' ' between them, or Postgres will not use this index and search turns
-- into a sequential scan of every email the site has ever received.
--
-- 'english' is passed as a literal so the expression is immutable, which is what
-- makes it indexable at all. It is also a decision: the stemmer is English, and
-- a site corresponding in another language gets exact-word matching rather than
-- nothing.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "uin_messages_search_idx"
    ON "uin_messages"
 USING GIN (to_tsvector('english',
            coalesce("subject", '') || ' ' ||
            coalesce("from_name", '') || ' ' ||
            coalesce("from_address", '') || ' ' ||
            coalesce("body_text", '')));

-- ---------------------------------------------------------------------------
-- The list, and the unread counts beside every inbox in the rail.
--
-- The rail asks "how many unread, per inbox" on every render of the screen, and
-- the answer is a small fraction of the rows - so a partial index that holds
-- only the unread ones stays tiny however much mail the site accumulates.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "uin_threads_unread_idx"
    ON "uin_threads" ("inbox_id")
 WHERE "unread" = true;

-- The All view has no inbox to filter on, so it orders the whole table.
CREATE INDEX IF NOT EXISTS "uin_threads_last_message_idx"
    ON "uin_threads" ("last_message_at" DESC);

-- Snoozed conversations come back on their own. Whatever wakes them (a sweep in
-- a later version, or the list itself treating an elapsed snooze as open) wants
-- the few rows that are due, not a scan of every conversation ever closed.
CREATE INDEX IF NOT EXISTS "uin_threads_snooze_due_idx"
    ON "uin_threads" ("snooze_until")
 WHERE "snooze_until" IS NOT NULL;
