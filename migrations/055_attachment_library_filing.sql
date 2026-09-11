-- Unified Inbox - Migration 055: attachments become media library items.
--
-- A NEW numbered file, as every schema change in this module is: a migration is
-- recorded once per install and never runs again, so editing an earlier one
-- reaches a fresh install and nobody else. Everything below is idempotent, and
-- there is no dollar-quoting anywhere, comments included, because the backup
-- round-trip harness skips a whole module whose migration files carry a pair of
-- them - and a gate that skips is a gate that proved nothing.
--
-- Both columns are types this module already stores (TEXT and BOOLEAN), so the
-- schema-coverage backstop needs no new branch.
--
-- ---------------------------------------------------------------------------
-- What this is for.
--
-- Attachments used to be written under one flat private prefix with no library
-- row, so that a customer's invoice could not appear in the media picker for
-- everybody holding media permission. The site owner asked for the opposite:
-- files on the media page, filed under who the correspondence was with. See
-- lib/attachment-filing.ts for the folder shape.
--
-- Which raises a question the old arrangement never had to answer: WHOSE object
-- is this? Two quite different things sit in media_key.
--
--   - A file this module wrote. Inbound bytes fetched off the mail server, or a
--     document dropped onto a message. Deleting the message should take the
--     file with it.
--   - A file somebody picked out of the media library and attached. The key
--     points at a library item that belongs to the site - a product photograph,
--     a price list - and deleting the email must NOT delete it. Emptying the bin
--     did exactly that before this column existed: a product image emailed to a
--     customer was removed from storage while its library row sat there pointing
--     at nothing.
--
-- owns_object settles it, and media_id is the library row to remove alongside
-- the bytes when the answer is yes.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_attachments" ADD COLUMN IF NOT EXISTS "media_id" TEXT;
ALTER TABLE "uin_attachments" ADD COLUMN IF NOT EXISTS "owns_object" BOOLEAN NOT NULL DEFAULT false;

-- What is already here. Every object this module wrote before today sits under
-- its own private folder, whatever the provider's prefix in front of it, and
-- nothing else in media_key does - a library pick is filed wherever the library
-- put it. So the folder name IS the ownership test for historic rows, and it is
-- the only chance to draw the line before the new column starts being written.
--
-- The DISTINCT ON is the second half of the rule, and it matters as much as the
-- folder name. Forwarding a message travels with the original's attachment, and
-- the row written for the forward carries the very same media_key - one object,
-- two rows. Exactly one of them may own it, or throwing away the forward would
-- take the bytes off the message it was forwarded from. The earliest row wins,
-- which is the message the file actually arrived on.
UPDATE "uin_attachments" a
   SET "owns_object" = true
  FROM (
        SELECT DISTINCT ON ("media_key") "id"
          FROM "uin_attachments"
         WHERE "media_key" LIKE '%unified-inbox/%'
         ORDER BY "media_key", "created_at" ASC, "id" ASC
       ) first_holder
 WHERE a."id" = first_holder."id"
   AND a."owns_object" = false;

-- Answering "which attachment holds this library row" for the delete paths.
-- Partial, because it is only ever asked of the rows that have one.
CREATE INDEX IF NOT EXISTS "uin_attachments_media_id_idx"
    ON "uin_attachments" ("media_id")
    WHERE "media_id" IS NOT NULL;
