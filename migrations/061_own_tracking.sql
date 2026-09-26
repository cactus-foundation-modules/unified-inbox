-- Unified Inbox - Migration 061: the site's own tracking, for mail that goes
-- out through an ordinary mail account.
--
-- A NEW numbered file, as every schema change in this module is: a migration is
-- recorded once per install and never runs again, so editing an earlier one
-- reaches a fresh install and nobody else. Everything below is idempotent, and
-- there is no dollar-quoting anywhere, comments included, because the backup
-- round-trip harness skips a whole module whose migration files carry a pair of
-- them - and a gate that skips is a gate that proved nothing.
--
-- Every column is TEXT or BOOLEAN, both of which this module already stores, so
-- the schema-coverage backstop needs no new branch.
--
-- ---------------------------------------------------------------------------
-- What this is for.
--
-- Receipts (011, 047, 056) came from Brevo: it counts opens and clicks on what
-- it sends and tells us. An inbox sending through its own mail account over
-- SMTP - iCloud, say - has nobody counting, so core now does it itself: an
-- invisible picture and a redirect on the site's own domain, and a delivery
-- report that comes back to a mailbox matched to the message it is about. See
-- core's lib/email/tracking.
--
-- Its events land in the same ledger as Brevo's (uin_delivery_events), with
-- source = 'site' so the history screen can say where each one came from. What
-- this migration adds is the means of finding our message when one arrives, and
-- of saying honestly what an SMTP send can and cannot tell us.
-- ---------------------------------------------------------------------------

-- The EmailLog row core wrote for the send. Every open, click and bounce the
-- site's own tracking sees is filed against that row, so this is how one of
-- them finds its way here - for a reply written in this module and for a copy
-- of another module's mail kept on a conversation alike.
ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "email_log_id" TEXT;

CREATE INDEX IF NOT EXISTS "uin_messages_email_log_idx"
    ON "uin_messages" ("email_log_id")
 WHERE "email_log_id" IS NOT NULL;

-- 'brevo' | 'smtp' - which way it actually went. An SMTP send has no delivery
-- report to wait for, only "accepted by the mail server" and, sometimes, a
-- bounce; the screen says so rather than waiting for a "Delivered" that is
-- never coming.
ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "sent_via" TEXT;

-- Whether the site's own picture and links went out on it.
ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "site_tracked" BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- The switch, per inbox.
--
-- On by default, matching the site-wide switch in Settings > Emails, which
-- still has the last word: an inbox with this on sends untracked if the site
-- has tracking off. Only ever matters for an inbox sending over SMTP; Brevo
-- counts its own.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_inboxes" ADD COLUMN IF NOT EXISTS "own_tracking" BOOLEAN NOT NULL DEFAULT true;
