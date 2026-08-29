-- Unified Inbox - telling something else when the post arrives (S11)
--
-- A NEW numbered file rather than an edit to an earlier one: a module migration
-- is recorded once per install and never runs again, so editing 001 reaches a
-- fresh install and nobody else. Everything below is idempotent.
--
-- No dollar-quoting anywhere in this file, comments included - the backup
-- round-trip harness skips any module whose migrations contain a pair of them,
-- and a skipped module is a green gate that proved nothing.
--
-- Deliberately no sequence: one is invisible to information_schema.tables, and
-- a backup that misses one hands a restored site a counter starting from the
-- beginning. Attempt numbers are plain integers on the row that owns them.
--
-- Column types are the ones this module already uses - text, boolean, integer,
-- timestamp, text[] and jsonb - so the backup serialiser needs no new branch.

-- ---------------------------------------------------------------------------
-- The subscriptions themselves.
--
-- One row per "when this happens, tell that URL". Scoped to an inbox, or to all
-- of them when inbox_id is NULL, because the common case is a single automation
-- watching one address rather than the whole hub.
--
-- The secret and the extra headers are encrypted at rest: the headers field is
-- where a Cloudflare Access service token or an API key ends up, and those are
-- credentials however casually they were pasted in.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "uin_webhooks" (
    "id"                    TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "name"                  TEXT         NOT NULL,
    -- NULL means every inbox, including ones added later.
    "inbox_id"              TEXT,
    "url"                   TEXT         NOT NULL,
    "enabled"               BOOLEAN      NOT NULL DEFAULT true,
    -- Which happenings fire it. Today only 'message.received' is published;
    -- the column is a list so that assignment, sending and the rest can join
    -- later without a schema change.
    "events"                TEXT[]       NOT NULL DEFAULT ARRAY['message.received']::text[],
    -- 'event'   - the described payload for this happening.
    -- 'literal' - the body in "literal_body", sent verbatim every time. This is
    --             what an endpoint expecting its own shape needs, and it is the
    --             only style that sends nothing about the message at all.
    "payload_style"         TEXT         NOT NULL DEFAULT 'event',
    "literal_body"          TEXT,
    -- Off by default and it matters: a webhook URL is a copy of the post going
    -- somewhere else, so the body of a message travels only when somebody has
    -- deliberately said it may.
    "include_body"          BOOLEAN      NOT NULL DEFAULT false,
    -- Signs the request. Encrypted, and never returned to the browser after it
    -- has been saved - the screen only ever needs to know whether one is set.
    "secret_encrypted"      TEXT,
    -- A JSON object of extra request headers, encrypted whole.
    "headers_encrypted"     TEXT,
    -- What happened last time, so the settings screen can say so plainly.
    "last_status"           TEXT,
    "last_attempt_at"       TIMESTAMP(3),
    "last_error"            TEXT,
    "consecutive_failures"  INTEGER      NOT NULL DEFAULT 0,
    -- Set when a run of failures switched it off by itself. Distinct from
    -- "enabled" false, which means a person switched it off.
    "auto_disabled_at"      TIMESTAMP(3),
    "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_webhooks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uin_webhooks_payload_style_check"
        CHECK ("payload_style" IN ('event', 'literal'))
);

-- Dropping an inbox takes its webhooks with it. A subscription to an address
-- that no longer exists has nothing left to say.
ALTER TABLE "uin_webhooks" DROP CONSTRAINT IF EXISTS "uin_webhooks_inbox_id_fkey";
ALTER TABLE "uin_webhooks"
    ADD CONSTRAINT "uin_webhooks_inbox_id_fkey"
    FOREIGN KEY ("inbox_id") REFERENCES "uin_inboxes" ("id") ON DELETE CASCADE;

-- The question the ingest path asks, once per message that lands: which live
-- subscriptions care about this inbox.
CREATE INDEX IF NOT EXISTS "uin_webhooks_live_idx"
    ON "uin_webhooks" ("inbox_id")
    WHERE "enabled" = true AND "auto_disabled_at" IS NULL;

-- ---------------------------------------------------------------------------
-- The outbox.
--
-- Deliveries are queued and sent by the scheduled tick, never inline during
-- ingest. A laptop that is asleep, an endpoint that hangs, a site behind a slow
-- tunnel: none of them may stall a mail sync or lose a message that has already
-- been filed.
--
-- The payload is frozen onto the row at the moment it is queued. A retry three
-- hours later then sends what was true when the mail arrived, rather than
-- whatever the conversation has since become.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "uin_webhook_deliveries" (
    "id"              TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "webhook_id"      TEXT         NOT NULL,
    "event"           TEXT         NOT NULL,
    "message_id"      TEXT,
    "thread_id"       TEXT,
    -- 'pending' | 'sent' | 'failed' | 'dead'. 'failed' is waiting for another
    -- go; 'dead' has run out of them.
    "status"          TEXT         NOT NULL DEFAULT 'pending',
    "attempts"        INTEGER      NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload"         JSONB        NOT NULL,
    "response_code"   INTEGER,
    "error"           TEXT,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at"    TIMESTAMP(3),

    CONSTRAINT "uin_webhook_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uin_webhook_deliveries_status_check"
        CHECK ("status" IN ('pending', 'sent', 'failed', 'dead'))
);

ALTER TABLE "uin_webhook_deliveries" DROP CONSTRAINT IF EXISTS "uin_webhook_deliveries_webhook_id_fkey";
ALTER TABLE "uin_webhook_deliveries"
    ADD CONSTRAINT "uin_webhook_deliveries_webhook_id_fkey"
    FOREIGN KEY ("webhook_id") REFERENCES "uin_webhooks" ("id") ON DELETE CASCADE;

-- One message fires one subscription once, however many times a tick re-reads
-- the mailbox. The guard is the index rather than a check in the code, because
-- two ticks racing is the case that defeats a check in the code.
CREATE UNIQUE INDEX IF NOT EXISTS "uin_webhook_deliveries_once_idx"
    ON "uin_webhook_deliveries" ("webhook_id", "event", "message_id")
    WHERE "message_id" IS NOT NULL;

-- What the sender picks up each tick: everything owed a go, oldest first.
CREATE INDEX IF NOT EXISTS "uin_webhook_deliveries_due_idx"
    ON "uin_webhook_deliveries" ("next_attempt_at")
    WHERE "status" IN ('pending', 'failed');

-- What the settings screen shows for one subscription, and what the nightly
-- tidy-up prunes.
CREATE INDEX IF NOT EXISTS "uin_webhook_deliveries_recent_idx"
    ON "uin_webhook_deliveries" ("webhook_id", "created_at" DESC);
