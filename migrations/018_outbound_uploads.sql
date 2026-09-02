-- Unified Inbox - Migration 018: a file dropped onto a message being written.
--
-- A NEW numbered file rather than an edit to an earlier one: a module migration
-- is recorded once per install and never runs again, so editing 001 reaches a
-- fresh install and nobody else. Everything below is idempotent, and there is
-- no dollar-quoting anywhere - comments included - because the backup
-- round-trip harness skips a whole module whose migration files carry a pair of
-- them, which buys a green gate that proved nothing.
--
-- Every column here is TEXT, INTEGER or TIMESTAMP(3), all of which this module
-- already stores, so the schema-coverage backstop needs no new branch.
--
-- ---------------------------------------------------------------------------
-- Why a table at all.
--
-- Dragging a quote onto a reply puts the bytes into object storage before
-- anything is sent - the send route only ever takes an attachment by where it
-- already lives, and that has to stay true. Which leaves an object in the
-- bucket that nothing yet points at: the message has not been sent, and it may
-- never be, because the person may close the tab and think no more about it.
--
-- Two things then go wrong without this table. Core's storage check classifies
-- an object no row owns as ORPHANED and the repair offers it up for deletion,
-- so an attachment on a saved draft could be binned out from under it weeks
-- before it was sent. And nothing would ever tidy up after the drops that were
-- genuinely abandoned, so the bucket would grow forever.
--
-- So every drop is recorded here. lib/media-usage-provider.ts vouches for these
-- keys exactly as it vouches for the attachments table, so nothing offers them
-- for deletion; and the nightly housekeeping removes the rows - and the bytes -
-- once they are old and nothing points at them. See lib/retention.ts.
--
-- The row is deliberately NOT deleted when the message is sent. The send path
-- writes its own uin_attachments row against the same key, and the sweep skips
-- anything that table holds; letting the sweep do the removing means one rule
-- decides when bytes go, rather than two that can disagree.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "uin_outbound_uploads" (
    "id"             TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    -- Who dropped it. Their account going takes their unsent drops with it,
    -- the same bargain uin_drafts strikes.
    "author_user_id" TEXT         NOT NULL,
    -- Where the bytes are, in the shape the send route wants them.
    "media_key"      TEXT         NOT NULL,
    "media_url"      TEXT         NOT NULL,
    "media_provider" TEXT         NOT NULL,
    "filename"       TEXT         NOT NULL,
    "content_type"   TEXT,
    "size_bytes"     INTEGER      NOT NULL DEFAULT 0,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_outbound_uploads_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uin_outbound_uploads_author_fk"
        FOREIGN KEY ("author_user_id") REFERENCES "User" ("id") ON DELETE CASCADE
);

-- One row per object. The key carries a fresh random id, so this only ever
-- fires if the same row were somehow recorded twice.
CREATE UNIQUE INDEX IF NOT EXISTS "uin_outbound_uploads_key_key"
    ON "uin_outbound_uploads" ("media_key");

-- What the nightly sweep walks: oldest first.
CREATE INDEX IF NOT EXISTS "uin_outbound_uploads_created_idx"
    ON "uin_outbound_uploads" ("created_at");
