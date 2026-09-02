-- ---------------------------------------------------------------------------
-- One signing password and one set of extra headers for the whole site, with
-- each subscription free to use its own instead.
--
-- Sites that tell something else about their post nearly always tell ONE thing
-- - a workflow tool, an ops channel - from several inboxes, and typing the same
-- key into five subscriptions means changing it in five places on the day it is
-- rotated. So the shared pair lives on the settings row, and each subscription
-- says which it wants.
--
-- Encrypted at rest exactly as the per-subscription pair already is: the shared
-- headers field is where a service token ends up, and that is a credential
-- however casually it was pasted in.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_settings" ADD COLUMN IF NOT EXISTS "webhook_secret_encrypted"  TEXT;
ALTER TABLE "uin_settings" ADD COLUMN IF NOT EXISTS "webhook_headers_encrypted" TEXT;

-- 'shared' - the pair above, whatever it is on the day the delivery goes out.
-- 'own'    - this subscription's own, in the columns 008 already added.
-- 'none'   - neither. Unsigned, no extra headers.
--
-- Added without a default on purpose. A default fills every existing row with
-- it, and 'shared' would silently start signing subscriptions that have never
-- been signed - new headers turning up unannounced at somebody else's endpoint.
-- So existing rows are backfilled to whatever they do today, and only then does
-- the column take 'shared' as the default for the ones added from here on.
ALTER TABLE "uin_webhooks" ADD COLUMN IF NOT EXISTS "secret_source"  TEXT;
ALTER TABLE "uin_webhooks" ADD COLUMN IF NOT EXISTS "headers_source" TEXT;

-- Scoped to NULL, so running this file twice cannot overwrite a choice somebody
-- has since made.
UPDATE "uin_webhooks"
   SET "secret_source" = CASE WHEN "secret_encrypted" IS NULL THEN 'none' ELSE 'own' END
 WHERE "secret_source" IS NULL;

UPDATE "uin_webhooks"
   SET "headers_source" = CASE WHEN "headers_encrypted" IS NULL THEN 'none' ELSE 'own' END
 WHERE "headers_source" IS NULL;

ALTER TABLE "uin_webhooks" ALTER COLUMN "secret_source"  SET DEFAULT 'shared';
ALTER TABLE "uin_webhooks" ALTER COLUMN "headers_source" SET DEFAULT 'shared';
ALTER TABLE "uin_webhooks" ALTER COLUMN "secret_source"  SET NOT NULL;
ALTER TABLE "uin_webhooks" ALTER COLUMN "headers_source" SET NOT NULL;

-- Dropped first so the file can be run again without tripping over its own
-- constraint, the way 008 handles its foreign key.
ALTER TABLE "uin_webhooks" DROP CONSTRAINT IF EXISTS "uin_webhooks_secret_source_check";
ALTER TABLE "uin_webhooks"
    ADD CONSTRAINT "uin_webhooks_secret_source_check"
    CHECK ("secret_source" IN ('shared', 'own', 'none'));

ALTER TABLE "uin_webhooks" DROP CONSTRAINT IF EXISTS "uin_webhooks_headers_source_check";
ALTER TABLE "uin_webhooks"
    ADD CONSTRAINT "uin_webhooks_headers_source_check"
    CHECK ("headers_source" IN ('shared', 'own', 'none'));
