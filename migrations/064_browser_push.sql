-- Unified Inbox - Migration 064: new-mail nudges delivered by the browser's own
-- push service, so they arrive with the tab closed, the laptop lid shut and on
-- a phone with the Home Screen app in a pocket.
--
-- A NEW numbered file, as every change in this module is: a migration is
-- recorded once per install and never runs again. Idempotent throughout (ADD
-- COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS),
-- and deliberately free of dollar-quoted blocks - the backup round-trip harness
-- skips any module whose migration files contain a pair of them, comments
-- included. Column types are text and timestamp(3) only, both of which the core
-- backup serialiser already covers.
--
-- See lib/web-push.ts for the protocol and lib/push-nudges.ts for who is told
-- what.

-- The site's own signing pair for the push services (VAPID, RFC 8292). Made the
-- first time anybody turns nudges on, and kept: every subscription a browser
-- holds is bound to the public half, so a new pair strands them all. The
-- private half is encrypted with ENCRYPTION_KEY like every other secret here.
ALTER TABLE "uin_settings" ADD COLUMN IF NOT EXISTS "push_vapid_public" TEXT;
ALTER TABLE "uin_settings" ADD COLUMN IF NOT EXISTS "push_vapid_private_encrypted" TEXT;

-- One row per browser that has said yes. The endpoint is the address the push
-- service gave that browser, and it is unique: one browser is one person at a
-- time, so a colleague signing in on a shared machine and turning nudges on
-- takes the row over rather than both of them being told.
CREATE TABLE IF NOT EXISTS "uin_push_subscriptions" (
    "id"         TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "user_id"    TEXT         NOT NULL,
    "endpoint"   TEXT         NOT NULL,
    -- The browser's own encryption key and secret, base64url. What the payload
    -- is sealed with, so the push service in the middle cannot read a subject
    -- line on its way past.
    "p256dh"     TEXT         NOT NULL,
    "auth"       TEXT         NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_push_subscriptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uin_push_subscriptions_user_fkey"
        FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "uin_push_subscriptions_endpoint_key"
    ON "uin_push_subscriptions" ("endpoint");
CREATE INDEX IF NOT EXISTS "uin_push_subscriptions_user_idx"
    ON "uin_push_subscriptions" ("user_id");

-- Every incoming message a nudge round has already claimed. Mail is collected
-- by the hourly job, by Check now, by the admin page's own timer and by a
-- provider ringing, and two of those can finish at the same moment: the primary
-- key is what makes one message one nudge however many of them go looking.
-- A ledger rather than a flag on the message, so the biggest table in the
-- module is not rewritten to add it. Pruned nightly by the housekeeping job.
CREATE TABLE IF NOT EXISTS "uin_push_nudged" (
    "message_id" TEXT         NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_push_nudged_pkey" PRIMARY KEY ("message_id")
);

CREATE INDEX IF NOT EXISTS "uin_push_nudged_created_idx"
    ON "uin_push_nudged" ("created_at");

-- When a message reached the site, as opposed to when it says it was written.
-- Both the nudge round and the browser's own "anything new?" question ask this
-- of incoming mail only, and every round asks it, so it gets an index of its
-- own that leaves everything the site sent out of it.
CREATE INDEX IF NOT EXISTS "uin_messages_arrived_idx"
    ON "uin_messages" ("created_at")
    WHERE "direction" = 'in';
