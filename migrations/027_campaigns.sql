-- ---------------------------------------------------------------------------
-- S8: campaigns.
--
-- The same email to a great many people, one at a time, slowly, from an address
-- that is already a real mailbox on this site.
--
-- That last part is the whole design. This is NOT a newsletter service and it
-- is not trying to be one: there is no template gallery, no click tracking and
-- no rented sending domain. It is the composer somebody already uses, pointed
-- at a list from the address book, with a clock in front of it - one message
-- every ninety seconds inside working hours, so that two thousand emails leave
-- looking like two thousand emails a person sent rather than one burst a
-- filtering service is paid to notice.
--
-- Consequences of that, which the tables below are shaped by:
--
--   A CAMPAIGN SEND MAKES NO CONVERSATION. Five thousand threads in the hub
--   would bury the actual correspondence, so what is kept is a row per
--   recipient and a row per send, and nothing else. A REPLY is what makes a
--   conversation, and it makes one on the next mail collection exactly as any
--   other mail does.
--
--   THE PACE BELONGS TO THE ADDRESS, NOT TO THE CAMPAIGN. Two campaigns going
--   out of hi@ at ninety seconds each is one email every forty-five seconds
--   from hi@, which is not what anybody set. So the clock is a row per sending
--   address - uin_campaign_lanes - and every campaign on that address queues
--   behind it.
--
--   NOTHING IS SENT TWICE, EVER. One row per recipient per step, with the pair
--   unique, so a claim that somehow ran twice writes one send. This is the
--   failure that cannot be apologised for afterwards.
--
-- Idempotent throughout, and no dollar-quoted blocks anywhere in this file,
-- comments included: the backup round-trip harness skips any module whose
-- migrations contain a pair of them, and a skipped module is a green gate that
-- proved nothing about the tables below.
--
-- Every column here is TEXT, TEXT[], INTEGER, BOOLEAN or TIMESTAMP(3), all of
-- which the backup serialiser already has a branch for, so the schema-coverage
-- backstop needs no new one.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- The campaign itself: who it goes to, when it may go, and how fast.
--
-- `inbox_id` is ON DELETE SET NULL rather than CASCADE. An address being
-- removed must never take the record of what was sent from it with it - the
-- campaign stops, says in English that the address it sent from is gone, and
-- everything already sent stays exactly where it is.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "uin_campaigns" (
    "id"                  TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "name"                TEXT         NOT NULL,
    -- The address it goes out as, and the address replies come back to. Null
    -- only once somebody has deleted that address out from under it.
    "inbox_id"            TEXT,

    -- 'draft'    - being written. Nothing has been sent and the audience is not
    --              fixed yet.
    -- 'running'  - the clock is on it.
    -- 'paused'   - somebody pressed pause, or it paused itself. See pause_kind.
    -- 'done'     - every recipient has been through every step, or replied.
    -- 'stopped'  - somebody ended it early. Nothing further will be sent,
    --              chases included.
    "status"              TEXT         NOT NULL DEFAULT 'draft',
    -- Why it is paused, in a sentence, and what kind of pause it is - a person,
    -- the bounce guard, the mail service, or the address disappearing. Kept
    -- apart because the first is somebody's decision and the other three are
    -- something to fix.
    "pause_kind"          TEXT,
    "pause_reason"        TEXT,

    -- Whether the address's own signature goes on the bottom. Per campaign,
    -- because a signature that reads "Marcus, Sales" is right on a reply and
    -- occasionally wrong on a mailshot.
    "include_signature"   BOOLEAN      NOT NULL DEFAULT TRUE,
    -- Whether the unsubscribe footer goes on. On by default and the dialog says
    -- what switching it off means: an opt-out is what the Privacy and
    -- Electronic Communications Regulations actually ask for, and the site
    -- owner is the one who gets to decide, not this table.
    "include_unsubscribe" BOOLEAN      NOT NULL DEFAULT TRUE,
    -- Whether each send is also filed in the mailbox's own Sent folder over
    -- IMAP. Off, because five thousand of them buries the real correspondence
    -- in the mail app the owner reads on their phone.
    "copy_to_sent"        BOOLEAN      NOT NULL DEFAULT FALSE,

    -- ---- the clock ------------------------------------------------------
    --
    -- Every one of these is in the SITE's timezone, worked out in the code from
    -- wall clock rather than stored as an offset: 08:00 has to still mean 08:00
    -- on the Monday after the clocks change.

    -- The first moment it may send. Null on a draft that has never been started.
    "start_at"            TIMESTAMP(3),
    -- Minutes past midnight, site time. 480 is 08:00; 1020 is 17:00.
    "window_start_minute" INTEGER      NOT NULL DEFAULT 480,
    "window_end_minute"   INTEGER      NOT NULL DEFAULT 1020,
    "weekdays_only"       BOOLEAN      NOT NULL DEFAULT TRUE,
    -- Calendar dates to sit out, "YYYY-MM-DD" in site time. Weekdays-only still
    -- sends on Christmas Day, and nobody means that.
    "skip_dates"          TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    -- Seconds between one message leaving and the next being allowed to.
    "interval_seconds"    INTEGER      NOT NULL DEFAULT 90,
    -- Up to this many seconds added at random on top, so the gaps are not
    -- identical to the second. Zero is fine and is the default.
    "jitter_seconds"      INTEGER      NOT NULL DEFAULT 0,
    -- A ceiling for one day on top of the interval, or null for none.
    "daily_cap"           INTEGER,
    -- Warm-up: start at `ramp_start` a day and double each sending day until
    -- the interval alone is the limit. For a domain that normally sends five
    -- emails a day and is about to send three hundred.
    "ramp_enabled"        BOOLEAN      NOT NULL DEFAULT FALSE,
    "ramp_start"          INTEGER      NOT NULL DEFAULT 50,

    -- ---- the audience ---------------------------------------------------
    --
    -- Fixed when it starts, not evaluated as it goes: a list that changes every
    -- time somebody imports a spreadsheet is a list whose finish date moves. The
    -- categories are kept so that "top up with anyone added since" has something
    -- to ask, and the two exclusions are kept because the reason a name is not
    -- in the list is a question somebody will ask a fortnight later.
    "exclude_colleagues"  BOOLEAN      NOT NULL DEFAULT TRUE,

    "created_by"          TEXT,
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- When it first started sending, and when the last recipient was settled.
    "started_at"          TIMESTAMP(3),
    "finished_at"         TIMESTAMP(3),

    CONSTRAINT "uin_campaigns_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "uin_campaigns" DROP CONSTRAINT IF EXISTS "uin_campaigns_inbox_fk";
ALTER TABLE "uin_campaigns" ADD CONSTRAINT "uin_campaigns_inbox_fk"
    FOREIGN KEY ("inbox_id") REFERENCES "uin_inboxes" ("id") ON DELETE SET NULL;

ALTER TABLE "uin_campaigns" DROP CONSTRAINT IF EXISTS "uin_campaigns_status_check";
ALTER TABLE "uin_campaigns" ADD CONSTRAINT "uin_campaigns_status_check"
    CHECK ("status" IN ('draft', 'running', 'paused', 'done', 'stopped'));

ALTER TABLE "uin_campaigns" DROP CONSTRAINT IF EXISTS "uin_campaigns_pause_kind_check";
ALTER TABLE "uin_campaigns" ADD CONSTRAINT "uin_campaigns_pause_kind_check"
    CHECK ("pause_kind" IS NULL
           OR "pause_kind" IN ('manual', 'bounces', 'provider', 'address-gone'));

-- A window with an end before its start would send nothing, for ever, silently.
ALTER TABLE "uin_campaigns" DROP CONSTRAINT IF EXISTS "uin_campaigns_window_check";
ALTER TABLE "uin_campaigns" ADD CONSTRAINT "uin_campaigns_window_check"
    CHECK ("window_start_minute" >= 0
           AND "window_end_minute" <= 1440
           AND "window_start_minute" < "window_end_minute");

-- Twenty seconds at the bottom, because anything faster is a burst with extra
-- steps and this feature exists to not do that. An hour at the top, because a
-- gap longer than that is a campaign nobody will live to see the end of.
ALTER TABLE "uin_campaigns" DROP CONSTRAINT IF EXISTS "uin_campaigns_interval_check";
ALTER TABLE "uin_campaigns" ADD CONSTRAINT "uin_campaigns_interval_check"
    CHECK ("interval_seconds" >= 20 AND "interval_seconds" <= 3600);

ALTER TABLE "uin_campaigns" DROP CONSTRAINT IF EXISTS "uin_campaigns_jitter_check";
ALTER TABLE "uin_campaigns" ADD CONSTRAINT "uin_campaigns_jitter_check"
    CHECK ("jitter_seconds" >= 0 AND "jitter_seconds" <= 600);

ALTER TABLE "uin_campaigns" DROP CONSTRAINT IF EXISTS "uin_campaigns_daily_cap_check";
ALTER TABLE "uin_campaigns" ADD CONSTRAINT "uin_campaigns_daily_cap_check"
    CHECK ("daily_cap" IS NULL OR ("daily_cap" >= 1 AND "daily_cap" <= 100000));

ALTER TABLE "uin_campaigns" DROP CONSTRAINT IF EXISTS "uin_campaigns_ramp_check";
ALTER TABLE "uin_campaigns" ADD CONSTRAINT "uin_campaigns_ramp_check"
    CHECK ("ramp_start" >= 1 AND "ramp_start" <= 100000);

-- What the list screen asks for: the ones still going, newest first.
CREATE INDEX IF NOT EXISTS "uin_campaigns_status_idx"
    ON "uin_campaigns" ("status", "created_at" DESC);

-- Every campaign due a look on this tick, which is the query the runner opens
-- with. Partial, because on most sites on most days the answer is none.
CREATE INDEX IF NOT EXISTS "uin_campaigns_running_idx"
    ON "uin_campaigns" ("start_at")
 WHERE "status" = 'running';


-- ---------------------------------------------------------------------------
-- Which labels from the address book it was built from.
--
-- A join table rather than a list of ids in a column, so a category being
-- deleted takes its row with it rather than leaving an id that matches nothing
-- and a "top up" that quietly stops finding anybody.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "uin_campaign_categories" (
    "campaign_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,

    CONSTRAINT "uin_campaign_categories_pkey" PRIMARY KEY ("campaign_id", "category_id"),
    CONSTRAINT "uin_campaign_categories_campaign_fk"
        FOREIGN KEY ("campaign_id") REFERENCES "uin_campaigns" ("id") ON DELETE CASCADE,
    CONSTRAINT "uin_campaign_categories_category_fk"
        FOREIGN KEY ("category_id") REFERENCES "uin_contact_categories" ("id") ON DELETE CASCADE
);


-- ---------------------------------------------------------------------------
-- The message, and the chases after it.
--
-- Step 0 is the email itself. Steps 1 to 3 are what goes out if nobody has
-- replied, each waiting its own number of days after the step before it.
--
-- `subject` is null on a chase, which means "Re: whatever step 0 said" - the
-- chase is threaded onto the first message, so it lands in the same
-- conversation in the recipient's mail program rather than arriving as a
-- stranger asking whether they saw the last one.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "uin_campaign_steps" (
    "id"          TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "campaign_id" TEXT         NOT NULL,
    "step_index"  INTEGER      NOT NULL,
    -- Days after the previous step went out. Null on step 0, which goes when
    -- the campaign's own clock says so.
    "wait_days"   INTEGER,
    "subject"     TEXT,
    -- As it was typed, newlines and all. The markup is made at the moment of
    -- sending, the same way the composer makes it, so what goes back into the
    -- box is what came out of it.
    "body"        TEXT         NOT NULL DEFAULT '',
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_campaign_steps_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uin_campaign_steps_campaign_fk"
        FOREIGN KEY ("campaign_id") REFERENCES "uin_campaigns" ("id") ON DELETE CASCADE
);

ALTER TABLE "uin_campaign_steps" DROP CONSTRAINT IF EXISTS "uin_campaign_steps_index_check";
ALTER TABLE "uin_campaign_steps" ADD CONSTRAINT "uin_campaign_steps_index_check"
    CHECK ("step_index" >= 0 AND "step_index" <= 3);

-- A day at the bottom: a chase that arrives the same afternoon reads as a
-- machine. Ninety at the top, because a chase three months later is a new
-- campaign wearing a chase's coat.
ALTER TABLE "uin_campaign_steps" DROP CONSTRAINT IF EXISTS "uin_campaign_steps_wait_check";
ALTER TABLE "uin_campaign_steps" ADD CONSTRAINT "uin_campaign_steps_wait_check"
    CHECK ("wait_days" IS NULL OR ("wait_days" >= 1 AND "wait_days" <= 90));

CREATE UNIQUE INDEX IF NOT EXISTS "uin_campaign_steps_order_key"
    ON "uin_campaign_steps" ("campaign_id", "step_index");


-- ---------------------------------------------------------------------------
-- One person on one campaign.
--
-- The name and the company are COPIED here rather than read through to the
-- address book when the message is made, so that a contact renamed halfway
-- through a fortnight's sending does not have the first four hundred emails and
-- the last four hundred disagree about what they were called.
--
-- The person link is ON DELETE CASCADE, and that is a decision about erasure
-- rather than about tidiness. These rows hold a name, an address and a company:
-- they ARE personal data, and a contact who exercises their right to be
-- forgotten (D17) has to take them with them. What is left behind is the
-- campaign and its counts, which are facts about the business rather than about
-- a person. The alternative - keeping the row so that a future campaign
-- remembers not to write to them - keeps their address on file in order to
-- promise not to use it, which is not a promise anybody asked for.
--
-- `address` is unique per campaign, which is the deduplication rule and is
-- enforced here rather than trusted to the code that builds the list: two
-- contacts genuinely do share an address, and the same person is genuinely in
-- two of the chosen categories.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "uin_campaign_recipients" (
    "id"                TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "campaign_id"       TEXT         NOT NULL,
    -- Null for somebody who was written to without ever becoming a contact.
    -- A contact who IS here and is then erased takes this row with them - see
    -- the note above.
    "person_id"         TEXT,
    "address"           TEXT         NOT NULL,
    "first_name"        TEXT,
    "last_name"         TEXT,
    "display_name"      TEXT,
    "organisation_name" TEXT,

    -- 'queued'       - waiting for its next step.
    -- 'sending'      - claimed by a run that has not settled it yet.
    -- 'replied'      - they wrote back. Nothing further goes to them.
    -- 'unsubscribed' - they asked not to hear from us again.
    -- 'bounced'      - the address does not work.
    -- 'complained'   - they pressed the spam button. Worse than unsubscribed
    --                  and kept apart from it, because the number of these is
    --                  what decides whether the domain keeps working.
    -- 'failed'       - the mail service refused it and said why.
    -- 'skipped'      - never sent to at all, with a reason: suppressed, no
    --                  address, or mailed too recently by another campaign.
    -- 'done'         - every step went out and nobody replied.
    "state"             TEXT         NOT NULL DEFAULT 'queued',
    -- Which step goes next. 0 is the message itself.
    "step_index"        INTEGER      NOT NULL DEFAULT 0,
    -- The earliest this recipient's next step may go. The lane decides the
    -- actual moment; this decides eligibility.
    "due_at"            TIMESTAMP(3),
    "claimed_at"        TIMESTAMP(3),

    -- The Message-ID of the first message we sent them, which every chase is
    -- threaded onto, and of the most recent one, which is what a chase says it
    -- is in reply to.
    "first_message_id"  TEXT,
    "last_message_id"   TEXT,
    "first_subject"     TEXT,
    "last_sent_at"      TIMESTAMP(3),

    "replied_at"        TIMESTAMP(3),
    "unsubscribed_at"   TIMESTAMP(3),
    "bounced_at"        TIMESTAMP(3),
    -- Why it was skipped or how it failed, in a sentence somebody can act on.
    "reason"            TEXT,

    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_campaign_recipients_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uin_campaign_recipients_campaign_fk"
        FOREIGN KEY ("campaign_id") REFERENCES "uin_campaigns" ("id") ON DELETE CASCADE,
    CONSTRAINT "uin_campaign_recipients_person_fk"
        FOREIGN KEY ("person_id") REFERENCES "uin_people" ("id") ON DELETE CASCADE
);

ALTER TABLE "uin_campaign_recipients" DROP CONSTRAINT IF EXISTS "uin_campaign_recipients_state_check";
ALTER TABLE "uin_campaign_recipients" ADD CONSTRAINT "uin_campaign_recipients_state_check"
    CHECK ("state" IN ('queued', 'sending', 'replied', 'unsubscribed', 'bounced',
                       'complained', 'failed', 'skipped', 'done'));

-- One row per address per campaign. The deduplication rule, in the only place
-- it cannot be got wrong.
CREATE UNIQUE INDEX IF NOT EXISTS "uin_campaign_recipients_address_key"
    ON "uin_campaign_recipients" ("campaign_id", lower("address"));

-- What the runner asks for: the next few due on this campaign. Partial, so the
-- index is the size of the queue rather than the size of the campaign.
CREATE INDEX IF NOT EXISTS "uin_campaign_recipients_due_idx"
    ON "uin_campaign_recipients" ("campaign_id", "due_at" ASC)
 WHERE "state" = 'queued';

-- What the Watch table and every count on the progress bar ask for.
CREATE INDEX IF NOT EXISTS "uin_campaign_recipients_state_idx"
    ON "uin_campaign_recipients" ("campaign_id", "state");

-- "Has this person been mailed by anything recently", for the cooldown, and
-- "did this reply come from somebody on a campaign", for standing chases down.
CREATE INDEX IF NOT EXISTS "uin_campaign_recipients_person_idx"
    ON "uin_campaign_recipients" ("person_id")
 WHERE "person_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "uin_campaign_recipients_address_idx"
    ON "uin_campaign_recipients" (lower("address"));

-- Claims from a run that died, which the next run puts back.
CREATE INDEX IF NOT EXISTS "uin_campaign_recipients_claimed_idx"
    ON "uin_campaign_recipients" ("claimed_at")
 WHERE "state" = 'sending';


-- ---------------------------------------------------------------------------
-- One message that actually left.
--
-- The pair (recipient, step) is unique, and that is the whole anti-duplicate
-- story: the row is written BEFORE the mail service is called, so a run that
-- dies mid-send leaves evidence, and a second run trying the same step hits the
-- index rather than sending a second copy. A person who receives the same
-- mailshot twice unsubscribes, and they are right to.
--
-- `address` is copied here as well as onto the recipient, because the cooldown
-- guard - do not mail the same human twice in a week - asks about addresses
-- across every campaign there has ever been, and that question should not have
-- to join through anything.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "uin_campaign_sends" (
    "id"                  TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "campaign_id"         TEXT         NOT NULL,
    "recipient_id"        TEXT         NOT NULL,
    "step_index"          INTEGER      NOT NULL,
    "address"             TEXT         NOT NULL,
    -- 'sending' until the mail service answers, then 'sent' or 'failed'.
    "status"              TEXT         NOT NULL DEFAULT 'sending',
    "error"               TEXT,
    -- Our own Message-ID, without the angle brackets, exactly as every other
    -- outgoing message in this module carries it.
    "message_id"          TEXT,
    "provider_message_id" TEXT,
    "sent_at"             TIMESTAMP(3),

    -- What became of it, when the site has asked to be told. The same four the
    -- rest of the module already understands.
    "delivered_at"        TIMESTAMP(3),
    "opened_at"           TIMESTAMP(3),
    "bounced_at"          TIMESTAMP(3),
    "bounce_kind"         TEXT,
    "bounce_detail"       TEXT,

    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_campaign_sends_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uin_campaign_sends_campaign_fk"
        FOREIGN KEY ("campaign_id") REFERENCES "uin_campaigns" ("id") ON DELETE CASCADE,
    CONSTRAINT "uin_campaign_sends_recipient_fk"
        FOREIGN KEY ("recipient_id") REFERENCES "uin_campaign_recipients" ("id") ON DELETE CASCADE
);

ALTER TABLE "uin_campaign_sends" DROP CONSTRAINT IF EXISTS "uin_campaign_sends_status_check";
ALTER TABLE "uin_campaign_sends" ADD CONSTRAINT "uin_campaign_sends_status_check"
    CHECK ("status" IN ('sending', 'sent', 'failed'));

-- One send per recipient per step. Nothing else in this file matters as much.
CREATE UNIQUE INDEX IF NOT EXISTS "uin_campaign_sends_step_key"
    ON "uin_campaign_sends" ("recipient_id", "step_index");

-- The stats on the campaign screen, and the bounce guard's own count.
CREATE INDEX IF NOT EXISTS "uin_campaign_sends_campaign_idx"
    ON "uin_campaign_sends" ("campaign_id", "sent_at" DESC);

-- The cooldown: has this address had anything from any campaign lately.
CREATE INDEX IF NOT EXISTS "uin_campaign_sends_address_idx"
    ON "uin_campaign_sends" (lower("address"), "sent_at" DESC);

-- Matching a delivery event back to the send it is about.
CREATE INDEX IF NOT EXISTS "uin_campaign_sends_message_idx"
    ON "uin_campaign_sends" ("message_id")
 WHERE "message_id" IS NOT NULL;

-- What went out today, for the daily cap and the warm-up ramp.
CREATE INDEX IF NOT EXISTS "uin_campaign_sends_sent_idx"
    ON "uin_campaign_sends" ("sent_at")
 WHERE "sent_at" IS NOT NULL;


-- ---------------------------------------------------------------------------
-- The pace, which belongs to the sending address.
--
-- One row per inbox, holding the earliest moment anything may next leave it.
-- Every campaign on that address takes the row, reads the moment, and puts the
-- next one back - so two campaigns out of hi@ share one ninety second gap
-- instead of halving it, and a second run of the tick sees the row already
-- claimed and walks away rather than sending on top of the first.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "uin_campaign_lanes" (
    "inbox_id"     TEXT         NOT NULL,
    -- The earliest moment the next campaign message may leave this address.
    "next_send_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Held by whichever run is sending right now, so nothing else takes the
    -- lane from under it. Released when the run settles, and taken to be a run
    -- that died once it is old enough.
    "claimed_at"   TIMESTAMP(3),

    CONSTRAINT "uin_campaign_lanes_pkey" PRIMARY KEY ("inbox_id"),
    CONSTRAINT "uin_campaign_lanes_inbox_fk"
        FOREIGN KEY ("inbox_id") REFERENCES "uin_inboxes" ("id") ON DELETE CASCADE
);


-- ---------------------------------------------------------------------------
-- Everybody who is never to be sent a campaign again.
--
-- Global, and outlives everything. A campaign being deleted must not quietly
-- re-permit mail to somebody who unsubscribed from it, which is exactly what a
-- per-campaign list would do; and an unsubscribe link has to keep working long
-- after the campaign that carried it has gone, so the link carries a signature
-- of the address rather than an id pointing at a row.
--
-- `campaign_id` is ON DELETE SET NULL for the same reason: it says where this
-- came from, and losing that is a footnote. Losing the suppression is a legal
-- problem and a rude one.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "uin_suppressions" (
    "id"          TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "address"     TEXT         NOT NULL,
    -- 'unsubscribed' - they asked, through the link or by hand.
    -- 'bounced'      - the address is dead. Hard bounces only; a full mailbox
    --                  on Tuesday is not a reason to never write again.
    -- 'complained'   - they marked it as spam.
    -- 'manual'       - somebody here added them.
    "reason"      TEXT         NOT NULL,
    "campaign_id" TEXT,
    "note"        TEXT,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_suppressions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uin_suppressions_campaign_fk"
        FOREIGN KEY ("campaign_id") REFERENCES "uin_campaigns" ("id") ON DELETE SET NULL
);

ALTER TABLE "uin_suppressions" DROP CONSTRAINT IF EXISTS "uin_suppressions_reason_check";
ALTER TABLE "uin_suppressions" ADD CONSTRAINT "uin_suppressions_reason_check"
    CHECK ("reason" IN ('unsubscribed', 'bounced', 'complained', 'manual'));

-- One row per address however it was typed. An unsubscribe arriving twice is
-- one suppression, and the second changes nothing.
CREATE UNIQUE INDEX IF NOT EXISTS "uin_suppressions_address_key"
    ON "uin_suppressions" (lower(btrim("address")));

CREATE INDEX IF NOT EXISTS "uin_suppressions_created_idx"
    ON "uin_suppressions" ("created_at" DESC);


-- ---------------------------------------------------------------------------
-- The site-wide settings campaigns add.
--
-- Both are guards rather than preferences, which is why they are here and not
-- on each campaign: a rule that stops two campaigns mailing the same person on
-- the same morning is worth nothing if one campaign can opt out of it.
-- ---------------------------------------------------------------------------

-- How many days must pass before any campaign may write to the same address
-- again. Zero switches the guard off for a site that genuinely wants it off.
ALTER TABLE "uin_settings" ADD COLUMN IF NOT EXISTS "campaign_cooldown_days" INTEGER NOT NULL DEFAULT 7;

ALTER TABLE "uin_settings" DROP CONSTRAINT IF EXISTS "uin_settings_campaign_cooldown_check";
ALTER TABLE "uin_settings" ADD CONSTRAINT "uin_settings_campaign_cooldown_check"
    CHECK ("campaign_cooldown_days" >= 0 AND "campaign_cooldown_days" <= 365);

-- How long a campaign's own log is kept after it finishes. The conversations it
-- started are ordinary mail and live under the retention window like everything
-- else; this is the send-by-send ledger behind them, which is worth having for
-- a while and is not worth having for ever.
ALTER TABLE "uin_settings" ADD COLUMN IF NOT EXISTS "campaign_log_months" INTEGER NOT NULL DEFAULT 24;

ALTER TABLE "uin_settings" DROP CONSTRAINT IF EXISTS "uin_settings_campaign_log_check";
ALTER TABLE "uin_settings" ADD CONSTRAINT "uin_settings_campaign_log_check"
    CHECK ("campaign_log_months" >= 1 AND "campaign_log_months" <= 120);

-- Who the mail is from, in the sense the law means: a name and a place. It goes
-- in the footer under the unsubscribe link, because "who is this and how do I
-- make it stop" are one question and half an answer is no answer. Null until
-- somebody fills it in, and the campaign screen says so before it will start.
ALTER TABLE "uin_settings" ADD COLUMN IF NOT EXISTS "campaign_footer_address" TEXT;

-- When somebody last sent themselves a test of this campaign. A campaign will
-- not start without one: the single most expensive mistake available here is a
-- broken merge tag or a signature that renders as a wall of markup, and both are
-- obvious in a test and invisible in a preview.
ALTER TABLE "uin_campaigns" ADD COLUMN IF NOT EXISTS "tested_at" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- The tick address's own key.
--
-- Campaign sending is paced by how often something asks it to send the next
-- one, and the site's own scheduled round only comes past once an hour on most
-- hosting. That is fine for a chase due on Thursday and useless for one message
-- every ninety seconds, so there is a third way in: an address any free
-- uptime-pinger can be pointed at, minute by minute, carrying this key.
--
-- A key in the address rather than a header, deliberately, because the free
-- services that do this cannot set headers - the same bargain, for the same
-- reason, as the Brevo webhook address above it. Regenerated from the settings
-- screen if it ever needs to be.
-- ---------------------------------------------------------------------------
ALTER TABLE "uin_settings" ADD COLUMN IF NOT EXISTS "campaign_tick_token" TEXT;
