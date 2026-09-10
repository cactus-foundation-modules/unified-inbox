-- Unified Inbox - Migration 053: a conversation from another channel, thrown
-- away, staying thrown away.
--
-- A NEW numbered file rather than an edit to an earlier one: a module migration
-- is recorded once per install and never runs again, so editing an earlier one
-- would reach a fresh install and nobody else. Everything below is idempotent,
-- and there is no dollar-quoting anywhere - comments included - because the
-- backup round-trip harness skips a whole module whose migration files carry a
-- pair of them, which buys a green gate that proved nothing.
--
-- TEXT and TIMESTAMP(3) only, both of which this module already stores in a
-- dozen places, so the backup serialiser and its schema-coverage backstop need
-- no new branch.
--
-- ---------------------------------------------------------------------------
-- WHAT WAS WRONG.
--
-- Email has had an answer to this since 001. "uin_processed_messages" holds a
-- row per (account, folder, UID) whose conversation pointer goes to NULL when
-- the conversation is destroyed - so the location is still marked read, and the
-- next collection walks past the very post somebody has just emptied out of
-- their bin rather than filing it again as a discovery.
--
-- The channels had nothing of the sort. A live chat, an enquiry, a call, a text
-- is copied here from the module that owns it, and that module is the source of
-- truth and still holds every word. So: delete the conversation, empty the bin,
-- and the next collection asked the channel what it had, was handed the same
-- conversation back, and copied it in again from scratch. Every time. On the
-- live site this brought back a month of chats within the quarter-hour.
--
-- It was worse than one conversation returning, because the question the
-- collection asks a channel is "what has happened since the newest thing I hold
-- of yours" and the answer was worked out by looking at the conversations still
-- standing. Emptying a bin therefore wound that watermark BACKWARDS, and the
-- next pass re-listed - and re-copied - ground that had been settled for weeks.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS IS.
--
-- One row per conversation destroyed, holding the channel's own id for it and
-- nothing about the person: an enquiry id, a chat id, a call SID. It is a
-- gravestone, not a copy - there is deliberately nowhere in here to put a name,
-- an address or a word anybody wrote, which is what lets it survive an erasure
-- under D17 without keeping the thing that was erased.
--
-- "through" is the high-water mark: the newest message the conversation held
-- when it was destroyed. It does two jobs at once.
--
--   The collection skips a conversation the channel offers whose newest message
--   is at or below this line. That is the bin's promise kept - deleted stays
--   deleted, and no amount of collecting brings it back.
--
--   And when the party DOES write again, which on a chat they can because the
--   far end never closed the conversation, it comes back with what they said
--   and NOT with the history that was thrown away. Anything at or below the
--   line stays gone. That is the same shape email has always had: destroy a
--   message, and a fresh reply arrives as a new conversation carrying the new
--   words only.
--
-- The alternative - never letting it back at all - was rejected on purpose. A
-- customer typing into a live chat that this site has quietly stopped listening
-- to is a worse failure than a conversation reappearing, and it would be
-- invisible from in here.
--
-- The row is kept for ever. It is three short strings and a stamp; the floor it
-- draws is what stops a re-listing quietly undoing a retention sweep months
-- later, so there is nothing here worth sweeping up.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "uin_provider_deleted" (
    -- The manifest entry id the conversation was stored under - the channel,
    -- not the module. One module may publish several channels and the telephony
    -- one does.
    "provider_module" TEXT         NOT NULL,
    -- The owning module's own id for the conversation.
    "external_id"     TEXT         NOT NULL,
    -- Newest message it held when it was destroyed. Never moves backwards.
    "through"         TIMESTAMP(3) NOT NULL,
    "deleted_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_provider_deleted_pkey" PRIMARY KEY ("provider_module", "external_id")
);

-- The watermark read: the newest line drawn on a channel, asked once a pass
-- beside the same question over the conversations still standing.
CREATE INDEX IF NOT EXISTS "uin_provider_deleted_through_idx"
    ON "uin_provider_deleted" ("provider_module", "through" DESC);
