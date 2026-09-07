-- Unified Inbox - Migration 045: when a conversation last had post ARRIVE,
-- which is not the same question as when its newest message was written.
--
-- A NEW numbered file rather than an edit to an earlier one, because a module
-- migration is recorded once per install and never runs again: editing 001
-- would reach a fresh install and nobody else. Idempotent, and no dollar
-- quoting anywhere - comments included - because the backup round-trip harness
-- skips a whole module whose migration files carry a pair of them, which buys a
-- green gate that proved nothing. TIMESTAMP(3), which this module already
-- stores in a dozen places, so the backup serialiser and its schema-coverage
-- backstop need no new branch.
--
-- ---------------------------------------------------------------------------
-- WHAT WENT WRONG, AND WHY IT NEEDED A COLUMN.
--
-- The list of conversations is ordered by last_message_at, and touchThread only
-- ever moves that forward: GREATEST of what is there and the date on the new
-- message. Which is right, and is what stops an out-of-order reply rewriting a
-- conversation's history - but it means a message whose own date is BEHIND the
-- conversation's newest one lands completely silently. Correct thread, correct
-- inbox, right way up, and nothing anywhere on the screen moves.
--
-- That is not a rare shape. It is what happens every time somebody files an
-- email into a watched folder by hand after the fact: the mail is dated when it
-- was written, and it reaches us hours or days later. Seen on the live site on
-- 7 September 2026 - a supplier's reply dated 07:42 was moved into a watched
-- folder at 13:52, was collected correctly on the very next refresh, and joined
-- a conversation whose newest message was an outbound one at 07:50. It sorted
-- below the fold, under a subject line naming a different thing, with the old
-- preview still showing. The owner reasonably concluded it had not arrived.
--
-- So the row now carries both facts. last_message_at is still the date on the
-- mail and still only ever moves forward. last_arrived_at is when a message
-- reached US, and is written ONLY when the message does not move the
-- conversation forward - which is exactly the case the ordering used to lose.
-- Every other conversation keeps a NULL here for ever, and GREATEST ignores
-- NULLs, so the list is ordered precisely as it was for all of them.
--
-- NULL rather than a backfill of created_at. Stamping every existing row with
-- when it was collected would reorder 154 live conversations on the strength of
-- a history the site never recorded, to say something true about none of them.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_threads" ADD COLUMN IF NOT EXISTS "last_arrived_at" TIMESTAMP(3);

-- The list's own order, as an index, so the page is still taken by an index
-- scan rather than a sort of the whole table. Three keys because the ORDER BY
-- has three: arrival where there is one and the mail date otherwise, then the
-- mail date to break the ties that leaves, then the id so the paging is stable.
--
-- DESC NULLS LAST on the first two on purpose. Postgres defaults a DESC index
-- column to NULLS FIRST, which would not match the query and would leave the
-- index unused - and written this way round a backward scan of this one index
-- also serves the oldest-first ordering, which is its exact mirror.
CREATE INDEX IF NOT EXISTS "uin_threads_arrival_idx"
  ON "uin_threads" (
    GREATEST("last_message_at", "last_arrived_at") DESC NULLS LAST,
    "last_message_at" DESC NULLS LAST,
    "id" DESC
  );
