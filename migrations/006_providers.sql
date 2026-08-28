-- Unified Inbox - Migration 006: conversations that arrive from another module.
--
-- A chat, a contact form enquiry, a phone call and a text all reach this hub
-- through the seam core publishes, and they land in the same two tables an
-- email does. Three things were missing for that.
--
-- Idempotent throughout, and deliberately free of dollar-quoted blocks - the
-- backup round-trip harness skips any module whose migration files contain a
-- pair of them, comments included, and a skipped module is a green gate that
-- proved nothing.

-- Where a message came from when it did not come from a mailbox. The id is the
-- owning module's own - a submission id, a chat message id, a call SID - and it
-- is what stops the same message being filed twice as the tick re-reads a
-- conversation somebody has just added to.
ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "provider_module" TEXT;

-- The other party's number, for the channels that have one instead of an
-- address. Kept apart from "from_address" on purpose: that column is what the
-- people layer matches email identities on, and a phone number sitting in it
-- would mint a person with a telephone number for an email address.
ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "from_phone" TEXT;

-- One row per message a provider holds. Partial, because an email has no
-- provider message id and every one of them would otherwise collide.
CREATE UNIQUE INDEX IF NOT EXISTS "uin_messages_provider_message_key"
    ON "uin_messages" ("thread_id", "provider_message_id")
    WHERE "source" = 'provider' AND "provider_message_id" IS NOT NULL;

-- The tick asks one question of every provider: what has happened since the
-- newest thing I already hold of yours.
CREATE INDEX IF NOT EXISTS "uin_threads_provider_last_message_idx"
    ON "uin_threads" ("provider_module", "last_message_at" DESC)
    WHERE "provider_module" IS NOT NULL;
