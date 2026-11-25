-- Unified Inbox - Migration 078: rules.
--
-- "When mail like this arrives, do that to it" - written on the Rules tab by
-- whoever runs the inbox. The case that started it: a supplier answers a
-- purchase order with a brand-new email whose only link to the order is the
-- reference in its subject, and a rule puts the two conversations together.
-- See lib/rules.ts for what a rule can say and lib/rules-engine.ts for when it
-- is run.
--
-- A NEW numbered file, as every change in this module is. Idempotent
-- throughout (CREATE ... IF NOT EXISTS), free of dollar-quoted blocks - the
-- backup round-trip harness skips any module whose migrations contain a pair
-- of them, comments included - and only column types the core backup
-- serialiser already covers: text, integer, boolean, jsonb, timestamp(3).

-- ---------------------------------------------------------------------------
-- The rules themselves.
-- ---------------------------------------------------------------------------
--
-- conditions and actions are JSON because they are a little language rather
-- than a fixed set of columns, and every one of them is validated on the way
-- in (lib/rules.ts) and again on the way out - a rule that no longer reads is
-- skipped, never guessed at.
--
-- position is the order they run in, lowest first, and a rule may stop the
-- ones after it. fire_count and last_fired_at are what the list shows beside
-- each rule, so somebody can see at a glance whether theirs is doing anything.
CREATE TABLE IF NOT EXISTS "uin_rules" (
    "id"              TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "name"            TEXT         NOT NULL,
    "enabled"         BOOLEAN      NOT NULL DEFAULT true,
    "position"        INTEGER      NOT NULL DEFAULT 0,
    "trigger"         TEXT         NOT NULL DEFAULT 'newConversation',
    "match_mode"      TEXT         NOT NULL DEFAULT 'all',
    "conditions"      JSONB        NOT NULL DEFAULT '[]',
    "actions"         JSONB        NOT NULL DEFAULT '[]',
    "stop_processing" BOOLEAN      NOT NULL DEFAULT false,
    "fire_count"      INTEGER      NOT NULL DEFAULT 0,
    "last_fired_at"   TIMESTAMP(3),
    "created_by"      TEXT,
    "updated_by"      TEXT,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uin_rules_created_by_fk"
        FOREIGN KEY ("created_by") REFERENCES "User" ("id") ON DELETE SET NULL,
    CONSTRAINT "uin_rules_updated_by_fk"
        FOREIGN KEY ("updated_by") REFERENCES "User" ("id") ON DELETE SET NULL
);

-- The engine's one question, asked for every arriving message: the switched-on
-- rules, in order. Partial, so a site with no rules has an empty index.
CREATE INDEX IF NOT EXISTS "uin_rules_enabled_position_idx"
    ON "uin_rules" ("position", "created_at") WHERE "enabled" = true;

-- ---------------------------------------------------------------------------
-- What each rule did, and to which message.
-- ---------------------------------------------------------------------------
--
-- Two jobs. The unique pair is how a rule runs on a message ONCE: the
-- collecting pass, a re-collected copy of the same email and "run on recent
-- mail" can all reach the same message, and the second arrival finds the row
-- and stands down. And the summary is the rule's activity list on the Rules
-- tab - "Merged “Sales Order 0000980102 - PO-00091” into “Purchase order
-- PO-00091 ...”" - with the merge ids in detail so it can be put back.
--
-- Cascades with the rule and with the message: a deleted rule takes its
-- history with it, and a message the retention window removes takes its line
-- in the log. thread_id carries no foreign key - a merge moves the message to
-- another conversation, and the log should still say where it started.
CREATE TABLE IF NOT EXISTS "uin_rule_runs" (
    "id"         TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "rule_id"    TEXT         NOT NULL,
    "message_id" TEXT         NOT NULL,
    "thread_id"  TEXT,
    "summary"    TEXT,
    "detail"     JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_rule_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uin_rule_runs_rule_fk"
        FOREIGN KEY ("rule_id") REFERENCES "uin_rules" ("id") ON DELETE CASCADE,
    CONSTRAINT "uin_rule_runs_message_fk"
        FOREIGN KEY ("message_id") REFERENCES "uin_messages" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "uin_rule_runs_rule_message_key"
    ON "uin_rule_runs" ("rule_id", "message_id");
CREATE INDEX IF NOT EXISTS "uin_rule_runs_rule_created_idx"
    ON "uin_rule_runs" ("rule_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "uin_rule_runs_message_idx"
    ON "uin_rule_runs" ("message_id");
