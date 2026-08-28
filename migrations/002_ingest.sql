-- Unified Inbox - ingest engine (S3)
--
-- A NEW numbered file rather than an edit to 001: a module migration is
-- recorded once per install and never re-runs, so an in-place edit reaches a
-- fresh install and nobody else. 001 stays correct on its own; everything below
-- is idempotent, so the overlap is harmless either way.
--
-- NO dollar-quoted DO blocks anywhere in this module's migrations, and none may
-- be added - not even inside a comment. The backup round-trip test skips any
-- module whose SQL contains a dollar-quote at all, so one would buy a green gate
-- that never built these tables. Every CHECK goes inline in the table definition
-- instead, which is just as idempotent.
--
-- Column types stay inside the set the core backup serialiser has a branch for:
-- text / text[] / jsonb / boolean / integer / bigint / timestamp(3).

-- ---------------------------------------------------------------------------
-- A message's identity, and where we found it.
--
-- The Message-ID is what a message IS. The folder and UID are only where it was
-- sitting when we happened to look: the same mail lives in INBOX and in Archive,
-- and the owner moves it between the two from their phone. Storing the
-- connection alongside the header turns "have we already got this?" into one
-- indexed lookup that is right across every folder on the account.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "connection_id" TEXT;
ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "imap_folder"   TEXT;
ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "imap_uid"      BIGINT;
-- How the message found its thread: 'in-reply-to' | 'references' | 'heuristic'
-- | 'new'. Kept so a mis-threaded conversation can be diagnosed rather than
-- guessed at.
ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "thread_match"  TEXT;
-- Which header decided the inbox: 'delivered-to' | 'to' | 'cc' | 'from' |
-- 'catch-all' | 'none'. 'none' means nothing claimed it and nobody had a
-- catch-all, which the owner needs to be told about rather than left to guess.
ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "routed_on"     TEXT;
-- Machinery rather than a human: 'auto-reply' | 'bounce' | 'bulk'. NULL is an
-- ordinary message. An out-of-office quotes our own Message-ID and would
-- otherwise thread in as though the customer had replied.
ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "auto_kind"     TEXT;

-- One message per (account, Message-ID). This is the constraint that makes a
-- message seen in two folders one message, and that stops the copy we append to
-- Sent coming back at us as a fresh discovery. Partial, because provider and
-- manual messages have no connection and mail with no Message-ID at all is
-- given a content-hash identity instead.
CREATE UNIQUE INDEX IF NOT EXISTS "uin_messages_connection_message_id_key"
    ON "uin_messages" ("connection_id", "message_id_header")
    WHERE "connection_id" IS NOT NULL AND "message_id_header" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "uin_messages_location_idx"
    ON "uin_messages" ("connection_id", "imap_folder", "imap_uid");

-- ---------------------------------------------------------------------------
-- Attachments: enough to fetch the bytes back without a media library row.
--
-- These objects live under this module's own key prefix and deliberately never
-- get a Media row, so they cannot appear in the media picker for anybody who
-- happens to hold media permission. Storing the provider and the serving url
-- beside the key is what lets the module hand the bytes back later, and what
-- the media usage provider returns so the storage check counts them as claimed
-- rather than orphaned clutter with a delete button over it.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_attachments" ADD COLUMN IF NOT EXISTS "media_provider" TEXT;
ALTER TABLE "uin_attachments" ADD COLUMN IF NOT EXISTS "media_url"      TEXT;

-- ---------------------------------------------------------------------------
-- The per-account lock. An hourly tick, a Check now and (from the next stage) a
-- copy-to-Sent all want the same account at once, and iCloud caps how many
-- connections one account may hold open. The loser waits for the next tick
-- rather than opening a second connection and being refused.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_connections" ADD COLUMN IF NOT EXISTS "locked_until" TIMESTAMP(3);
-- How many times authentication has failed in a row. A rotated app password
-- stops collection dead, and without this the first anyone hears of it is a
-- customer complaining they were ignored for a fortnight.
ALTER TABLE "uin_connections" ADD COLUMN IF NOT EXISTS "auth_failures" INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Backfill progress, so "still working through your older mail" can say how far
-- it has got instead of spinning silently for a week.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_sync_state" ADD COLUMN IF NOT EXISTS "total_estimate" BIGINT;
ALTER TABLE "uin_sync_state" ADD COLUMN IF NOT EXISTS "collected"      BIGINT NOT NULL DEFAULT 0;
