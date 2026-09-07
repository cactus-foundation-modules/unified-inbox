-- Unified Inbox - Migration 048: the pictures that came inside the message.
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
-- A signature written in Outlook, a logo on a quote, a screenshot pasted into
-- the middle of a sentence: none of those are kept on a web server. They are
-- carried inside the message as ordinary attachments, and the markup points at
-- them by their Content-ID header rather than by an address - <img src="cid:
-- image001.png@01D9">. Every mail client in the world resolves that against the
-- parts of the message it arrived with.
--
-- This module stored the parts and stored the markup, and never wrote down
-- which part answered to which name, so nothing could put the two back
-- together. Every such picture drew an empty box, and the note above the
-- message cheerfully said that anything carried inside the message was already
-- there, which it was not.
--
-- Recorded at sync time from now on. Messages that arrived before this leave
-- the column empty, and the read path falls back to matching the name against
-- the filename - which is what Outlook and Apple Mail put in the Content-ID
-- anyway - so old post is fixed as far as it can be without going back to the
-- mail server for every attachment on the site.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_attachments" ADD COLUMN IF NOT EXISTS "content_id" TEXT;

-- The read path asks one message for its inline parts, and the message index
-- already answers that. This one is for the other direction - "is anything on
-- this site still referencing that Content-ID" - which is a question only worth
-- asking of the parts that have one.
CREATE INDEX IF NOT EXISTS "uin_attachments_content_id_idx"
    ON "uin_attachments" ("message_id", "content_id")
    WHERE "content_id" IS NOT NULL;
