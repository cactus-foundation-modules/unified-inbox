-- Unified Inbox - Migration 011: what became of a reply after it left.
--
-- A NEW numbered file rather than an edit to an earlier one: a module migration
-- is recorded once per install and never runs again, so editing 001 reaches a
-- fresh install and nobody else. Everything below is idempotent, and there is
-- no dollar-quoting anywhere - comments included - because the backup
-- round-trip harness skips a whole module whose migration files carry a pair of
-- them, which buys a green gate that proved nothing.
--
-- Every column here is TEXT, INTEGER, BOOLEAN or TIMESTAMP(3), all of which
-- this module already stores, so the schema-coverage backstop needs no new
-- branch for any of it.
--
-- ---------------------------------------------------------------------------
-- What this is for.
--
-- A reply leaves and the screen says "Sent", which means we handed it to a mail
-- service and the mail service took it. It does not mean it arrived, and it
-- certainly does not mean anybody read it. The person chasing a quote for the
-- third time deserves to know which of those three things actually happened
-- before they pick the phone up.
--
-- Two sources feed these columns, and they are not equally trustworthy:
--
--   The mail service's own events - delivered, opened, bounced. An open here is
--   an invisible image in the message being fetched, which is a decent signal
--   and an imperfect one: Apple Mail and Gmail fetch images on the reader's
--   behalf whether or not a human looked. Brevo says which is which, and
--   open_source keeps the two apart rather than reporting a machine as a
--   person.
--
--   A read receipt the recipient's own mail program sent back, because we
--   asked for one. Rarer, ignored by most clients, and worth more than a pixel
--   when it does arrive: somebody was asked and said yes.
--
-- Both are off until a site switches them on. Watching whether somebody opened
-- your email is tracking, whatever else it is, and it is not the sort of thing
-- to arrive switched on in an update.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "delivered_at"  TIMESTAMP(3);
ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "opened_at"     TIMESTAMP(3);
ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "last_open_at"  TIMESTAMP(3);
ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "open_count"    INTEGER NOT NULL DEFAULT 0;

-- 'human' | 'proxy' | 'receipt' - how the strongest open we have seen was
-- learned. A proxy open is the recipient's mail app prefetching the picture,
-- and saying "opened" for one of those to somebody deciding whether to chase a
-- customer is a lie with consequences.
ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "open_source"   TEXT;

ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "bounced_at"    TIMESTAMP(3);
-- 'hard' | 'soft' | 'blocked' | 'spam' | 'invalid' | 'deferred' | 'error'
ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "bounce_kind"   TEXT;
ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "bounce_detail" TEXT;

-- Outbound mail still waiting on a verdict, newest first. Small: only messages
-- sent since tracking was switched on ever have a row worth looking at.
CREATE INDEX IF NOT EXISTS "uin_messages_awaiting_receipt_idx"
    ON "uin_messages" ("sent_at" DESC)
    WHERE "direction" = 'out' AND "delivery_status" = 'sent' AND "delivered_at" IS NULL;

-- ---------------------------------------------------------------------------
-- The ledger behind those columns.
--
-- The columns above are the answer; this is the working. A message can be
-- opened eleven times over three weeks, deferred twice and then delivered, and
-- a single timestamp per outcome cannot show that. It also settles the awkward
-- half of taking events from somebody else's service: they are delivered at
-- least once, sometimes several times, and the same event arriving twice must
-- not count as two opens.
--
-- Hence the unique index on the three things that identify an occurrence. A
-- replay lands on it, changes nothing, and the counter is only moved when a row
-- was genuinely new.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "uin_delivery_events" (
    "id"          TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "message_id"  TEXT         NOT NULL,
    -- 'delivered' | 'opened' | 'proxy_open' | 'bounced' | 'receipt'
    "kind"        TEXT         NOT NULL,
    -- 'brevo' for the mail service's own events, 'receipt' for a read receipt
    -- the recipient's mail program sent back.
    "source"      TEXT         NOT NULL DEFAULT 'brevo',
    -- Whatever the service said about it, kept as a sentence rather than as
    -- JSON: it is only ever shown to a person, and a bounce reason is the one
    -- part of this a person actually wants to read.
    "detail"      TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_delivery_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uin_delivery_events_message_fk"
        FOREIGN KEY ("message_id") REFERENCES "uin_messages" ("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "uin_delivery_events_message_idx"
    ON "uin_delivery_events" ("message_id", "occurred_at" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "uin_delivery_events_occurrence_key"
    ON "uin_delivery_events" ("message_id", "kind", "occurred_at");

-- ---------------------------------------------------------------------------
-- The switches, and the token on the end of the webhook address.
--
-- The mail service pushes its events at a URL on this site. Brevo does not sign
-- what it sends, so the URL carries a long random token that has to match, the
-- same arrangement the live chat module uses for the same reason. It is minted
-- when tracking is first switched on and kept afterwards, so switching the
-- feature off and on again does not strand a webhook pointed at a dead address.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_settings" ADD COLUMN IF NOT EXISTS "track_opens"           BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "uin_settings" ADD COLUMN IF NOT EXISTS "request_read_receipts" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "uin_settings" ADD COLUMN IF NOT EXISTS "brevo_webhook_secret"  TEXT;
