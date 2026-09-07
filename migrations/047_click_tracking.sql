-- Unified Inbox - Migration 047: somebody followed a link.
--
-- A NEW numbered file, as every schema change in this module is: a migration is
-- recorded once per install and never runs again, so editing an earlier one
-- reaches a fresh install and nobody else. Everything below is idempotent and
-- there is no dollar-quoting anywhere, comments included, because the backup
-- round-trip harness skips a whole module whose migration files carry a pair of
-- them - and a gate that skips is a gate that proved nothing.
--
-- Every column added here is TEXT, INTEGER or TIMESTAMP(3), all of which this
-- module already stores, so the schema-coverage backstop needs no new branch.
--
-- ---------------------------------------------------------------------------
-- What this is for.
--
-- Migration 011 brought back three things about a sent reply: it arrived, it
-- was opened, it bounced. The one everybody actually asks about was missing.
-- "Did they look at the quote" is a question about the link to the quote, not
-- about whether an invisible picture at the bottom of the message loaded.
--
-- It only works where the mail service is rewriting the addresses in the
-- message so that following one goes through it first. That is a setting on the
-- Brevo account rather than anything this site controls, so these columns stay
-- empty on a site that has link tracking switched off, exactly as the open
-- columns stay empty on a site that never switched receipts on. Nothing breaks
-- either way.
--
-- A CLICK IS NOT PROOF OF A PERSON, and the screen is careful about saying so.
-- An office mail scanner opens every link in an arriving message to check where
-- it leads, and it does the lot within a second of delivery. Which is the whole
-- reason the link itself is kept rather than only a count: five clicks on five
-- different addresses one second after delivery reads very differently from one
-- click on the quote two hours later, and only the stored address tells them
-- apart.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "clicked_at"     TIMESTAMP(3);
ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "last_click_at"  TIMESTAMP(3);
ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "click_count"    INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Telling two clicks apart, which the old unique index cannot do.
--
-- 011 deduplicates an occurrence on (message, kind, moment), and that is right
-- for everything it was written for: a redelivered open is not a second open,
-- and Brevo redelivers anything it is not thanked for quickly enough.
--
-- It is wrong for clicks. Brevo stamps events to the second, and the common
-- case for several clicks in one second is precisely the case worth seeing -
-- the scanner working through every address in the message. Under the old key
-- all but one of those would land on the index and vanish, leaving a single
-- click that looks like a customer.
--
-- So clicks come out of that index and get one of their own that includes the
-- address. Two partial indexes rather than one wider one, because widening it
-- would change how a bounce and an open deduplicate as well, and those two have
-- been right since the day they were written.
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS "uin_delivery_events_occurrence_key";

CREATE UNIQUE INDEX IF NOT EXISTS "uin_delivery_events_occurrence_key"
    ON "uin_delivery_events" ("message_id", "kind", "occurred_at")
 WHERE "kind" <> 'clicked';

CREATE UNIQUE INDEX IF NOT EXISTS "uin_delivery_events_click_key"
    ON "uin_delivery_events" ("message_id", "occurred_at", COALESCE("detail", ''))
 WHERE "kind" = 'clicked';

-- ---------------------------------------------------------------------------
-- The campaign half.
--
-- One column, matching the shape of the four already there. A campaign send
-- keeps the first time anything in it was followed and nothing else: the
-- per-link working belongs to a conversation somebody is about to answer, and a
-- mailshot to nine hundred people wants a number, not a list.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_campaign_sends" ADD COLUMN IF NOT EXISTS "clicked_at" TIMESTAMP(3);
