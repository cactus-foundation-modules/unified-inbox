-- Unified Inbox - the send path (S4)
--
-- A NEW numbered file rather than an edit to 001 or 002: a module migration is
-- recorded once per install and never runs again, so an in-place edit reaches a
-- fresh install and nobody else. Everything below is idempotent, so an install
-- that has somehow seen part of it already comes to no harm.
--
-- Two harness rules this module has already paid for once each, both of them
-- tripped from inside a COMMENT rather than from any SQL:
--
--   No dollar-quoting anywhere in the file. The backup round-trip skips a whole
--   module whose migrations contain one, which buys a green gate that never
--   built the columns it was supposed to be checking.
--
--   In a file that only alters existing tables, the phrase for making a new one
--   must not appear at all. The schema-coverage test flags any migration that
--   mentions it but yields no parsed column, as drift detection for its own
--   regex, and a comment counts.
--
-- Column types stay inside the set the core backup serialiser has a branch for.

-- ---------------------------------------------------------------------------
-- Send idempotency (E14).
--
-- A double-clicked Send button is two requests, and a request that timed out
-- ambiguously is a third when the person tries again. Without a token supplied
-- by whoever pressed the button there is nothing to tell the second request
-- that the first one already exists: the pre-written 'sending' row can only
-- guard a send once something has created it, and each request would create its
-- own.
--
-- So the composer generates the token, the row carries it, and a second request
-- with the same token lands on the unique index, changes nothing, and is
-- answered with the message the first one already sent. Partial, because every
-- message this module has ever collected from a mail server has no token and
-- they must not all collide on NULL.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "idempotency_key" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "uin_messages_idempotency_key_key"
    ON "uin_messages" ("idempotency_key")
    WHERE "idempotency_key" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Which folder the copy of a sent reply was filed in, and where.
--
-- D4's copy-to-Sent is the one write this module makes to somebody's mailbox.
-- Recording where the copy landed means the settings screen can say whether it
-- worked, and means a failure is visible as a fact about that message rather
-- than as a line in a log nobody reads. It also gives the sync engine the
-- location for free when it next meets its own appended copy.
--
-- 'appended' | 'failed' | 'skipped' | NULL for a message where copying was
-- never asked for.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "append_status" TEXT;
ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "append_error"  TEXT;

-- ---------------------------------------------------------------------------
-- Which inbox a message was sent FROM.
--
-- An outbound message has no folder and no UID to work backwards from, and its
-- thread's inbox is not always the answer: a conversation can be moved, and a
-- thread that arrived unrouted has no inbox at all until somebody files it. The
-- sending identity, the signature and - most of all - who is allowed to read
-- the message afterwards all hang off this, so it is stored on the message and
-- not inferred later.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "inbox_id" TEXT;

CREATE INDEX IF NOT EXISTS "uin_messages_inbox_idx" ON "uin_messages" ("inbox_id");

-- Outbound mail waiting to be settled, oldest first. Small and almost always
-- empty, which is the point: anything sitting in 'sending' for longer than a
-- send takes is a crash between the row and the network call, and somebody has
-- to be able to find those.
CREATE INDEX IF NOT EXISTS "uin_messages_pending_send_idx"
    ON "uin_messages" ("delivery_status", "created_at")
    WHERE "delivery_status" = 'sending';

-- ---------------------------------------------------------------------------
-- The sender's Reply-To, kept from inbound mail.
--
-- A sender who sets Reply-To meant it: mail from a ticketing system, a shared
-- mailbox or anything sending on somebody else's behalf puts the address that
-- is actually read in there, and the From line is often a machine that reads
-- nothing. Answering From instead of Reply-To sends the reply somewhere nobody
-- looks, and the customer concludes they were ignored (E13).
--
-- Added here rather than in 002 because the ingest stage had nothing that read
-- it and so never stored it; the send path is the first thing that needs it.
-- Mail already collected has NULL and falls back to From, which is the correct
-- answer for the overwhelming majority of it.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "reply_to" TEXT;
