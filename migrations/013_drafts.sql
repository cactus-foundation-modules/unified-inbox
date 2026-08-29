-- Unified Inbox - Migration 013: a message put down half-written.
--
-- A NEW numbered file rather than an edit to an earlier one: a module migration
-- is recorded once per install and never runs again, so editing 001 reaches a
-- fresh install and nobody else. Everything below is idempotent, and there is
-- no dollar-quoting anywhere - comments included - because the backup
-- round-trip harness skips a whole module whose migration files carry a pair of
-- them, which buys a green gate that proved nothing.
--
-- Every column here is TEXT, TEXT[], JSONB or TIMESTAMP(3), all of which this
-- module already stores, so the schema-coverage backstop needs no new branch.
--
-- ---------------------------------------------------------------------------
-- What this is for.
--
-- Somebody starts a reply to a supplier, gets as far as the second paragraph,
-- and the phone goes. Today that writing lives in a textarea and nowhere else,
-- so the phone call costs them the reply. A draft is the answer every mail
-- program has had since the nineties, and this is that.
--
-- A table of its own rather than a row in uin_messages with a new status,
-- deliberately. An unsent draft is not a message: it has not got a Message-ID,
-- it is not part of the conversation's story, it must never be counted in a
-- thread, quoted by a later reply, swept up by retention, handed to a webhook
-- or copied into anybody's Sent folder. Every one of those would have to learn
-- to skip a status, and the one that forgot would be the one that mattered.
--
-- Whose draft it is matters as much as which conversation it belongs to. A
-- shared inbox has several people in it, and half-written text is nobody
-- else's business until it is sent - so a draft belongs to its author, and only
-- its author ever sees it. The author's own row goes when their account does:
-- there is nobody left who could finish the sentence.
--
-- The body is stored exactly as it was typed, not as the HTML it will become.
-- What goes back into the box when the draft is opened has to be what came out
-- of it, and rebuilding typed text from markup is a game of guessing where the
-- line breaks were.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "uin_drafts" (
    "id"             TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "author_user_id" TEXT         NOT NULL,
    -- Which address it would leave as. NULL while it is an answer to a
    -- conversation another module owns, which has no address at all.
    "inbox_id"       TEXT,
    -- The conversation being answered, or NULL for a message starting one.
    "thread_id"      TEXT,
    -- 'new' | 'reply' | 'reply-all' | 'forward'
    "mode"           TEXT         NOT NULL DEFAULT 'new',
    "to_addresses"   TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "cc_addresses"   TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "subject"        TEXT,
    -- As typed, newlines and all.
    "body"           TEXT         NOT NULL DEFAULT '',
    -- Where each file already lives in storage, exactly as the send route
    -- wants it. Never bytes: an attachment is described by where it is, so
    -- nothing can be talked into emailing an arbitrary file by asking nicely.
    "attachments"    JSONB        NOT NULL DEFAULT '[]'::jsonb,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_drafts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uin_drafts_mode_check"
        CHECK ("mode" IN ('new', 'reply', 'reply-all', 'forward')),
    CONSTRAINT "uin_drafts_author_fk"
        FOREIGN KEY ("author_user_id") REFERENCES "User" ("id") ON DELETE CASCADE,
    -- The address is gone, so there is nothing left to send this as. Matching
    -- uin_module_senders, which takes the same view of the same event.
    CONSTRAINT "uin_drafts_inbox_fk"
        FOREIGN KEY ("inbox_id") REFERENCES "uin_inboxes" ("id") ON DELETE CASCADE,
    CONSTRAINT "uin_drafts_thread_fk"
        FOREIGN KEY ("thread_id") REFERENCES "uin_threads" ("id") ON DELETE CASCADE
);

-- The drafts list: one person's own, newest first.
CREATE INDEX IF NOT EXISTS "uin_drafts_author_idx"
    ON "uin_drafts" ("author_user_id", "updated_at" DESC);

CREATE INDEX IF NOT EXISTS "uin_drafts_inbox_idx" ON "uin_drafts" ("inbox_id");

-- One draft per conversation per person. The composer under a conversation
-- opens on whatever was left there, and "whatever was left there" has to be a
-- single row or the box has to choose between two of them - which is how
-- somebody sends the older half of what they wrote. Partial, because every
-- draft starting a new conversation has no thread and they must not all
-- collide on NULL.
CREATE UNIQUE INDEX IF NOT EXISTS "uin_drafts_thread_author_key"
    ON "uin_drafts" ("thread_id", "author_user_id")
    WHERE "thread_id" IS NOT NULL;
