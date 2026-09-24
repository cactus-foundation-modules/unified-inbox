-- Unified Inbox - Migration 056: where a delivery event came from.
--
-- A NEW numbered file, as every schema change in this module is: a migration is
-- recorded once per install and never runs again, so editing an earlier one
-- reaches a fresh install and nobody else. Everything below is idempotent, and
-- there is no dollar-quoting anywhere, comments included, because the backup
-- round-trip harness skips a whole module whose migration files carry a pair of
-- them - and a gate that skips is a gate that proved nothing.
--
-- Both columns are TEXT, which this module already stores, so the
-- schema-coverage backstop needs no new branch for either.
--
-- ---------------------------------------------------------------------------
-- What this is for.
--
-- The ledger in uin_delivery_events says WHAT happened to a sent message and
-- WHEN. Pressing the label under a reply now opens the whole of that ledger,
-- and the first question anybody asks of an open they did not expect is "who
-- fetched it?" - because the honest answer is often the recipient's mail
-- security scanner rather than the recipient, and the address is how you tell.
--
-- The address is not in what Brevo pushes at us: its webhook carries the
-- browser (user_agent) but not the network address of whoever fetched the
-- picture. Its event report does carry one, so the history screen asks the
-- report when it opens and writes the address it learns onto the row here,
-- once. After that the row answers on its own.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_delivery_events" ADD COLUMN IF NOT EXISTS "ip"         TEXT;
ALTER TABLE "uin_delivery_events" ADD COLUMN IF NOT EXISTS "user_agent" TEXT;
