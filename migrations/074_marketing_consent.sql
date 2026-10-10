-- Unified Inbox - Migration 074: a contact's marketing consent, on record.
--
-- A NEW numbered file, as every change in this module is. Idempotent, free of
-- dollar-quoted blocks, and only boolean, timestamp and text columns the backup
-- serialiser already covers.
--
-- Whether somebody is happy to be sent marketing is a fact about the person,
-- and a contact card that cannot say so is no use the day somebody wants to
-- send a newsletter. It is a RECORD, not a tickbox: what they said, when they
-- said it and where - "Order DW000218" or "Changed by hand" - because consent
-- nobody can trace back to its source is consent nobody can show.
--
--   * marketing_consent         true = happy to hear from us, false = asked not
--                               to be, NULL = never asked.
--   * marketing_consent_at      when they gave that answer (an order's own
--                               time, not when it was copied here). The newest
--                               answer wins, so an older order synced late never
--                               overrides a newer one.
--   * marketing_consent_source  where the answer came from, in words.

ALTER TABLE "uin_people" ADD COLUMN IF NOT EXISTS "marketing_consent" BOOLEAN;
ALTER TABLE "uin_people" ADD COLUMN IF NOT EXISTS "marketing_consent_at" TIMESTAMP(3);
ALTER TABLE "uin_people" ADD COLUMN IF NOT EXISTS "marketing_consent_source" TEXT;
