-- Unified Inbox - Migration 033: a copy nobody else on the message can see.
--
-- A NEW numbered file rather than an edit to an earlier one: a module migration
-- is recorded once per install and never runs again, so editing 001 or 013
-- would reach a fresh install and nobody else. Both statements are idempotent,
-- and there is no dollar-quoting anywhere - comments included - because the
-- backup round-trip harness skips a whole module whose migration files carry a
-- pair of them, which buys a green gate that proved nothing.
--
-- Both columns are TEXT[], which this module already stores in half a dozen
-- places, so the schema-coverage backstop needs no new branch.
--
-- ---------------------------------------------------------------------------
-- What this is for.
--
-- The reply box can now say who a message goes to rather than only reporting
-- it, which means it can also say who gets a copy - and one of the two kinds of
-- copy is the kind the other recipients never see. A supplier is answered, the
-- owner is quietly copied in, and the supplier is not told that the owner was
-- reading over anybody's shoulder.
--
-- A column of its own on both tables rather than a flag beside cc_addresses,
-- for the reason that IS the whole feature: the difference between the two is
-- that one appears in the headers the other recipients read and the other does
-- not. Anything that put them in the same array would eventually render both,
-- and the day it did there would be no way to tell what had been sent to whom.
--
--   uin_messages.bcc_addresses  what actually went out blind, so the copy filed
--                               in the mailbox's own Sent folder is honest and
--                               so a retry sends the same message rather than a
--                               narrower one.
--   uin_drafts.bcc_addresses    the same list on a message put down half
--                               written, so opening a draft gives back the box
--                               it came out of.
--
-- Empty, never NULL, exactly as to_addresses and cc_addresses already are: a
-- list of nobody is an empty list, and every reader here would otherwise need a
-- coalesce it does not need today.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_messages"
    ADD COLUMN IF NOT EXISTS "bcc_addresses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "uin_drafts"
    ADD COLUMN IF NOT EXISTS "bcc_addresses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
