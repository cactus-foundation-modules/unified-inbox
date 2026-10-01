-- Unified Inbox - Migration 070: telling other modules that mail has arrived.
--
-- A NEW numbered file, as every change in this module is: a migration is
-- recorded once per install and never runs again. Idempotent (ADD COLUMN IF NOT
-- EXISTS, CREATE ... IF NOT EXISTS), free of dollar-quoted blocks - the backup
-- round-trip harness skips any module whose migration files contain a pair of
-- them, comments included - and only column types the core backup serialiser
-- already covers (text, integer, timestamp, timestamptz, jsonb).
--
-- The inbox now offers every inbound message to whichever modules listen on
-- `unified-inbox.message-received` - see lib/message-handlers.ts. Per message:
--
--   handled_at      when every listener had its turn. Null means never offered,
--                   or a run cut short, and the hourly catch-up offers anything
--                   from the last three days still null.
--   handler_notes   the one line each listener asked to show on the message -
--                   "Filed on PO-01234 as the proforma" - as a JSON array of
--                   { source, moduleName, note, at }. Null when nobody said
--                   anything, which is nearly every message.
--   offering_at     the claim. Set, atomically, by whoever is about to offer
--                   the message and cleared when they finish, so the collecting
--                   pass, the hourly catch-up and the "offer again" button can
--                   never run the listeners on one message at the same time. A
--                   claim older than two minutes belongs to a run that died and
--                   may be taken over.
--   offer_attempts  how many times a claim was taken. The catch-up works the
--                   fewest-tried first, so one message that keeps failing sinks
--                   to the back instead of blocking everything behind it.

ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "handled_at" TIMESTAMPTZ;
ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "handler_notes" JSONB;
ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "offering_at" TIMESTAMPTZ;
ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "offer_attempts" INTEGER NOT NULL DEFAULT 0;

-- The catch-up's question: inbound post from a person, never offered,
-- collected lately. Partial, so the index holds exactly the rows the catch-up
-- could want and nothing else - no outbound, no notes, no bounces or
-- newsletters. On a site with listeners it stays small: the catch-up stamps
-- everything in its window, offerable or not. On a site with NO listeners
-- nothing is ever stamped, so it grows by one small entry per inbound message
-- from a person - an index the size of a narrow slice of the table, never read
-- until something starts listening. That is the price of the catch-up being
-- one cheap range scan the day something does.
CREATE INDEX IF NOT EXISTS "uin_messages_unhandled_idx"
    ON "uin_messages" ("created_at")
    WHERE "handled_at" IS NULL AND "direction" = 'in' AND "auto_kind" IS NULL;

-- ---------------------------------------------------------------------------
-- Automatic links somebody took off.
--
-- A link a listener asked for is automatic, and removing one is one click - a
-- plain DELETE. Without a note of it, the very next offer of that message (the
-- hourly catch-up finishing a cut-short run, or "offer the last 14 days
-- again") would put it straight back, and a person's deliberate "no, not that
-- order" would last until the next time anybody pressed a button.
--
-- One row per conversation and record. Only automatic links are remembered:
-- somebody who added a link by hand and takes it off again has changed their
-- own mind, not corrected the site. The listener path will not re-add a link
-- remembered here; adding it by hand still works, and clears the note.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "uin_record_link_removals" (
    "thread_id"   TEXT         NOT NULL,
    "module_name" TEXT         NOT NULL,
    "record_type" TEXT         NOT NULL,
    "record_id"   TEXT         NOT NULL,
    "removed_by"  TEXT,
    "removed_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_record_link_removals_pkey"
        PRIMARY KEY ("thread_id", "module_name", "record_type", "record_id"),
    CONSTRAINT "uin_record_link_removals_thread_fk"
        FOREIGN KEY ("thread_id") REFERENCES "uin_threads" ("id") ON DELETE CASCADE,
    CONSTRAINT "uin_record_link_removals_user_fk"
        FOREIGN KEY ("removed_by") REFERENCES "User" ("id") ON DELETE SET NULL
);
