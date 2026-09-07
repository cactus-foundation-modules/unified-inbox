-- Unified Inbox - Migration 049: which message a half-written reply answers.
--
-- A NEW numbered file, as every schema change in this module is: a migration is
-- recorded once per install and never runs again, so editing an earlier one
-- reaches a fresh install and nobody else. Everything below is idempotent, and
-- there is no dollar-quoting anywhere, comments included, because the backup
-- round-trip harness skips a whole module whose migration files carry a pair of
-- them - and a gate that skips is a gate that proved nothing.
--
-- The one column added here is TEXT, which this module already stores, so the
-- schema-coverage backstop needs no new branch.
--
-- ---------------------------------------------------------------------------
-- What this is for.
--
-- Pressing Reply on the fourth message of nine quotes the fourth message. That
-- much the send route now works out from the message the arrow was pressed on -
-- but a reply that is saved, scheduled for the morning, or simply reopened
-- tomorrow goes out through the draft, and a draft that does not write down
-- which message it answers has to guess when its time comes. It guessed the
-- newest, which is how somebody's answer to Tuesday's question went out with
-- Friday's message quoted under it.
--
-- Null on every draft written before this, and null is exactly what it used to
-- mean: quote the newest message on the conversation.
--
-- The message it names can be deleted while the draft sits there, so the column
-- lets go rather than holding the row up - and the send route falls back to the
-- newest message when what it names is gone, because losing a paragraph
-- somebody wrote is worse than quoting slightly differently.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_drafts" ADD COLUMN IF NOT EXISTS "in_reply_to_message_id" TEXT;

ALTER TABLE "uin_drafts" DROP CONSTRAINT IF EXISTS "uin_drafts_in_reply_to_fk";
ALTER TABLE "uin_drafts" ADD CONSTRAINT "uin_drafts_in_reply_to_fk"
    FOREIGN KEY ("in_reply_to_message_id") REFERENCES "uin_messages" ("id") ON DELETE SET NULL;
