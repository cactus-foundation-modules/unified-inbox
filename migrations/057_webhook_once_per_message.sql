-- Unified Inbox - Migration 057: one message, one delivery per subscription.
--
-- A NEW numbered file rather than an edit to 008: a module migration is
-- recorded once per install and never runs again, so editing the earlier one
-- would reach a fresh install and nobody else. Idempotent, an index and nothing
-- else, and no dollar-quoting anywhere - comments included - because the backup
-- round-trip harness skips a whole module whose migration files carry a pair.
--
-- 008 made a subscription hear about one message once PER EVENT, which was the
-- same thing while arrival was the only event there was. It is not any more: a
-- conversation handed to somebody is keyed on the post being handed over, so
-- an email that lands in Bob's inbox and is handed to Bob a few seconds later
-- would tell Bob's endpoint about the same email twice. This index makes it
-- once, whichever event queued first, and in the database rather than in a
-- check in the code, because two requests racing is what defeats the code.
--
-- Safe on existing rows: before this release every queued delivery was a
-- message.received, so 008's index already made (webhook_id, message_id)
-- unique. 008's index stays - the version of the code still serving while an
-- update builds names it in its conflict clause.

CREATE UNIQUE INDEX IF NOT EXISTS "uin_webhook_deliveries_once_per_message_idx"
    ON "uin_webhook_deliveries" ("webhook_id", "message_id")
    WHERE "message_id" IS NOT NULL;
