-- Unified Inbox - Migration 037: the order the channels sit in down the rail.
--
-- A NEW numbered file rather than an edit to an earlier one: a module migration
-- is recorded once per install and never runs again, so editing an earlier file
-- reaches a fresh install and nobody else. Everything below is idempotent, and
-- there is no dollar-quoting anywhere - comments included - because the backup
-- round-trip harness skips a whole module whose migration files carry a pair of
-- them, which buys a green gate that proved nothing.
--
-- TEXT[] is already stored by this module (own_domains, hidden_channel_modules),
-- so the schema-coverage backstop needs no new branch.

-- The channel keys, in the order somebody has dragged them into. Empty is the
-- honest answer for a site nobody has rearranged, and it means "the order the
-- modules were found in", which is the order every install has been reading in
-- all along. A key naming a channel that is no longer installed is harmless -
-- nothing matches it - and is kept rather than dropped, so switching a module
-- off and back on again does not lose the place it was put in.
ALTER TABLE "uin_settings"
    ADD COLUMN IF NOT EXISTS "channel_order" TEXT[] NOT NULL DEFAULT '{}'::text[];
