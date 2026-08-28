-- ---------------------------------------------------------------------------
-- S6: people, identity resolution and the context rail.
--
-- The people layer is deliberately thin. It exists so that two emails, a live
-- chat and a phone call from the same human collapse into one story, and for
-- nothing else. There are no pipelines here, no stages, no scoring: this is not
-- a customer relationship manager and must never grow into one.
--
-- Idempotent throughout. No dollar-quoted blocks anywhere in this file,
-- comments included: the backup round-trip harness skips any module whose
-- migrations contain one, and a skipped module is a green gate that proved
-- nothing about the columns below. A constraint that Postgres cannot add
-- conditionally is dropped first and then added, which comes to the same thing
-- without needing a block.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Settings: what counts as us, what counts as a person, and what a reference to
-- one of the site's own records looks like.
--
-- Every one of these is a setting rather than a constant because a pattern
-- baked into the code would be one site's pattern, and this module ships to all
-- of them. NULL means "use the sensible default", which lets a site that has
-- never opened the screen behave properly and a site that has opened it keep
-- whatever it chose, including an empty list.
-- ---------------------------------------------------------------------------

-- Domains whose senders are colleagues rather than customers. NULL means "work
-- it out from the addresses this site collects mail on", which is right for
-- almost everybody and wrong for nobody who has said otherwise.
ALTER TABLE "uin_settings" ADD COLUMN IF NOT EXISTS "own_domains" TEXT[];

-- Extra consumer mail providers beyond the ones the module already knows, so a
-- site whose customers use a regional free provider does not end up with an
-- "organisation" per mailbox host.
ALTER TABLE "uin_settings" ADD COLUMN IF NOT EXISTS "personal_domains" TEXT[];

-- What an order, a purchase order and a quote reference look like in a subject
-- line. A pattern only ever PROPOSES a reference: nothing is linked until the
-- owning module confirms it holds a record with that exact number, so a pattern
-- that matches too much costs a failed lookup rather than a wrong link.
ALTER TABLE "uin_settings" ADD COLUMN IF NOT EXISTS "order_number_pattern" TEXT;
ALTER TABLE "uin_settings" ADD COLUMN IF NOT EXISTS "po_number_pattern" TEXT;
ALTER TABLE "uin_settings" ADD COLUMN IF NOT EXISTS "quote_number_pattern" TEXT;

-- ---------------------------------------------------------------------------
-- People.
-- ---------------------------------------------------------------------------

-- Set on the person who lost a merge. The row is kept rather than deleted, so a
-- merge somebody regrets is an update to undo rather than a person to rebuild
-- from memory. Everything that reads a list of people hides these.
ALTER TABLE "uin_people" ADD COLUMN IF NOT EXISTS "merged_into_id" TEXT;

ALTER TABLE "uin_people" DROP CONSTRAINT IF EXISTS "uin_people_merged_into_fk";
ALTER TABLE "uin_people" ADD CONSTRAINT "uin_people_merged_into_fk"
    FOREIGN KEY ("merged_into_id") REFERENCES "uin_people" ("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "uin_people_merged_into_idx" ON "uin_people" ("merged_into_id");

-- The address with plus-addressing stripped, which is what "have we met this
-- person before?" compares against. `value` keeps what the sender actually
-- wrote, because replying to the stripped form loses whatever the plus tag was
-- for. Not unique: two originals legitimately share one match key.
ALTER TABLE "uin_person_identities" ADD COLUMN IF NOT EXISTS "match_value" TEXT;
UPDATE "uin_person_identities" SET "match_value" = "value" WHERE "match_value" IS NULL;
CREATE INDEX IF NOT EXISTS "uin_person_identities_match_idx"
    ON "uin_person_identities" ("match_value");

-- ---------------------------------------------------------------------------
-- Merges, and how to take one back.
--
-- Merging is the operation most likely to be regretted, so it records enough to
-- reverse itself: which identities, threads and links moved, and what the
-- losing person looked like before. Undoing a merge puts each of them back
-- where it came from rather than guessing.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "uin_person_merges" (
    "id"         TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "winner_id"  TEXT         NOT NULL,
    "loser_id"   TEXT         NOT NULL,
    "user_id"    TEXT,
    -- The losing person's own columns plus the ids of everything that moved.
    -- No bodies, no addresses beyond the identities themselves.
    "snapshot"   JSONB        NOT NULL DEFAULT '{}',
    "undone_at"  TIMESTAMP(3),
    "undone_by"  TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_person_merges_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "uin_person_merges_winner_idx" ON "uin_person_merges" ("winner_id");
CREATE INDEX IF NOT EXISTS "uin_person_merges_loser_idx" ON "uin_person_merges" ("loser_id");

-- ---------------------------------------------------------------------------
-- Audit: the same table now answers for a person as well as a conversation.
--
-- A merge, a split and a link that was removed all want the same row shape as
-- an assignment or a snooze, and "who did this to this person and when" is the
-- question somebody asks a fortnight later.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_events" ALTER COLUMN "thread_id" DROP NOT NULL;
ALTER TABLE "uin_events" ADD COLUMN IF NOT EXISTS "person_id" TEXT;

ALTER TABLE "uin_events" DROP CONSTRAINT IF EXISTS "uin_events_person_fk";
ALTER TABLE "uin_events" ADD CONSTRAINT "uin_events_person_fk"
    FOREIGN KEY ("person_id") REFERENCES "uin_people" ("id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "uin_events_person_idx" ON "uin_events" ("person_id", "created_at" DESC);

-- ---------------------------------------------------------------------------
-- Links to the site's own records.
--
-- Two partial unique indexes so that re-running the linker on a conversation
-- that already has its order attached updates nothing rather than growing a
-- second identical row every hour. Partial because a link belongs to a
-- conversation or to a person, and comparing NULLs would defeat the constraint.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS "uin_record_links_thread_record_key"
    ON "uin_record_links" ("thread_id", "module_name", "record_type", "record_id")
    WHERE "thread_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "uin_record_links_person_record_key"
    ON "uin_record_links" ("person_id", "module_name", "record_type", "record_id")
    WHERE "person_id" IS NOT NULL AND "thread_id" IS NULL;

-- Finding the people a conversation has not been resolved to yet, which is what
-- the catch-up pass on the sync tick asks for on every run.
CREATE INDEX IF NOT EXISTS "uin_threads_unresolved_idx"
    ON "uin_threads" ("last_message_at" DESC)
    WHERE "person_id" IS NULL;

-- When the linker last read this conversation. A conversation is looked at
-- again once something newer has arrived on it, which is how a reference that
-- turns up in the third reply gets linked without re-reading the whole mailbox
-- every hour.
ALTER TABLE "uin_threads" ADD COLUMN IF NOT EXISTS "linked_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "uin_threads_linking_idx"
    ON "uin_threads" ("last_message_at" DESC)
    WHERE "linked_at" IS NULL;
