-- Asking a colleague to look at something, and letting them work through it.
--
-- Tagging somebody in an internal note already raised a bell notice and stopped
-- there. Two things were wrong with that.
--
-- The first is that the notice was the whole of it. A conversation somebody has
-- been asked about is a piece of work with a beginning and an end - "I will do
-- that on Thursday", "done, no need to look" - and there was nowhere for any of
-- that to be said. The conversation's OWN status could not carry it either:
-- that is one shared state, so three people asked to look at one order would
-- have marked it done from under each other.
--
-- So a tag is a row of its own, per person, with its own open / snoozed / done.
-- Everybody asked works through their own copy, and none of it touches where
-- the conversation itself stands.
--
-- The second is that a tag naming somebody who could not open the conversation
-- was dropped without a word, so asking a colleague outside accounts@ to look
-- at something looked exactly like asking one inside it. A tag now GRANTS that
-- one conversation to that one person - see canOpenThread in lib/access.ts.
-- Deliberately narrow: it is one conversation rather than the address it sits
-- in, it is only ever handed over by somebody who could already open it, and it
-- grants reading rather than answering. Sending as accounts@ remains a thing
-- only accounts@'s own people may do.
--
-- ONE ROW PER PERSON PER CONVERSATION, which is what the unique index below is
-- for. Being asked twice about the same thing is the same piece of work asked
-- about again, not two of them - so a second tag reopens the first rather than
-- stacking up beside it, and somebody who marked theirs done a fortnight ago
-- and has been asked again gets it back rather than nothing.
--
-- Idempotent throughout: every statement is guarded, so re-running this on an
-- install that already has it is a no-op.
--
-- Column types stay inside the set the core backup serialiser has a branch for
-- (text / timestamp(3)) - see the head of 001_initial.sql.

CREATE TABLE IF NOT EXISTS "uin_mentions" (
    "id"           TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "thread_id"    TEXT         NOT NULL,
    -- The note the tag was written on. Nullable because the retention sweep
    -- clears old messages out and the piece of work outlives the sentence that
    -- started it.
    "message_id"   TEXT,
    -- Who was asked.
    "user_id"      TEXT         NOT NULL,
    -- Who asked them. Nullable: a colleague can leave the business without
    -- taking what they asked for with them.
    "by_user_id"   TEXT,
    -- What the note said, held here so the list of what somebody has been asked
    -- about reads without opening every one of them.
    "note"         TEXT,
    -- 'open' | 'snoozed' | 'done'
    "status"       TEXT         NOT NULL DEFAULT 'open',
    "snooze_until" TIMESTAMP(3),
    "settled_at"   TIMESTAMP(3),
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_mentions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uin_mentions_status_check" CHECK ("status" IN ('open', 'snoozed', 'done')),
    -- The conversation going takes the ask with it: there is nothing left to
    -- look at, and a row pointing at a conversation that is not there would
    -- draw a list entry nobody could open.
    CONSTRAINT "uin_mentions_thread_fk"
        FOREIGN KEY ("thread_id") REFERENCES "uin_threads" ("id") ON DELETE CASCADE,
    CONSTRAINT "uin_mentions_message_fk"
        FOREIGN KEY ("message_id") REFERENCES "uin_messages" ("id") ON DELETE SET NULL,
    -- The person going takes their own list with them; the person who ASKED
    -- going leaves the work behind, because the work was never theirs.
    CONSTRAINT "uin_mentions_user_fk"
        FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE,
    CONSTRAINT "uin_mentions_by_user_fk"
        FOREIGN KEY ("by_user_id") REFERENCES "User" ("id") ON DELETE SET NULL
);

-- One live ask per person per conversation. This is the rule the whole table
-- hangs off: without it, asking Sam three times over a fortnight gives Sam
-- three identical things to clear.
CREATE UNIQUE INDEX IF NOT EXISTS "uin_mentions_thread_user_key"
    ON "uin_mentions" ("thread_id", "user_id");

-- What one person has been asked about, newest first - the list view, its
-- counts and the number on the rail all read this way round.
CREATE INDEX IF NOT EXISTS "uin_mentions_user_status_idx"
    ON "uin_mentions" ("user_id", "status", "created_at" DESC);

-- The other direction: everything asked about one conversation, for the badge
-- in its header and for the access check on every request against it.
CREATE INDEX IF NOT EXISTS "uin_mentions_thread_idx"
    ON "uin_mentions" ("thread_id");

-- The ones due to come back, for the sweep that wakes them. Partial, because
-- the overwhelming majority of rows are not snoozed and have no business in an
-- index the sweep walks every hour.
CREATE INDEX IF NOT EXISTS "uin_mentions_due_idx"
    ON "uin_mentions" ("snooze_until")
 WHERE "status" = 'snoozed' AND "snooze_until" IS NOT NULL;
