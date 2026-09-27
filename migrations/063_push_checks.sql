-- Unified Inbox - Migration 063: collect a mail account when its provider says
-- new mail has arrived, rather than on the hourly schedule.
--
-- A NEW numbered file, as every change in this module is: a migration is
-- recorded once per install and never runs again. Idempotent throughout (ADD
-- COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS), and deliberately free of
-- dollar-quoted blocks - the backup round-trip harness skips any module whose
-- migration files contain a pair of them, comments included. Column types are
-- boolean, text and timestamp(3) only, all of which the core backup serialiser
-- already covers.
--
-- Zoho Mail (and anything else that can POST to an address when mail lands) can
-- ring the site instead of the site asking every hour. The ring is a doorbell
-- and nothing more: whatever it carries is ignored, and the mail is still read
-- over IMAP exactly as a scheduled check reads it - so nothing about filing,
-- threading or dedupe changes. See lib/push-checks.ts.

-- Switched on, the hourly job and the admin page's automatic checks leave this
-- account alone, bar a slow safety net in case the provider stops ringing.
ALTER TABLE "uin_connections" ADD COLUMN IF NOT EXISTS "push_checks" BOOLEAN NOT NULL DEFAULT false;

-- The random part of the address the provider rings. Minted the first time the
-- switch is turned on and kept after that, so turning it off and on again does
-- not break a webhook already configured at the provider's end.
ALTER TABLE "uin_connections" ADD COLUMN IF NOT EXISTS "push_token" TEXT;

-- The key Zoho signs every ring with. It sends it once, on the very first
-- request, and never again - so it is kept, encrypted, the moment it arrives.
ALTER TABLE "uin_connections" ADD COLUMN IF NOT EXISTS "push_hook_secret_encrypted" TEXT;

-- When the provider last rang.
ALTER TABLE "uin_connections" ADD COLUMN IF NOT EXISTS "push_requested_at" TIMESTAMP(3);

-- The newest ring a finished check is known to have covered: a check notes the
-- newest ring when it starts reading, and writes it here when it is done. A
-- ring that finds the account busy waits until this passes it, rather than
-- trusting a check that may have read the folders before its mail arrived.
ALTER TABLE "uin_connections" ADD COLUMN IF NOT EXISTS "push_answered_at" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "uin_connections_push_token_key"
    ON "uin_connections" ("push_token")
    WHERE "push_token" IS NOT NULL;
