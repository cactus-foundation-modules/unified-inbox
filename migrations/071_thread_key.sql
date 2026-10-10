-- Unified Inbox - Migration 071: a name for a conversation another module owns.
--
-- A NEW numbered file, as every change in this module is. Idempotent, free of
-- dollar-quoted blocks, and a plain text column the backup serialiser already
-- covers.
--
-- A module's automatic emails used to be filed as a conversation each. That is
-- right for a purchase order and wrong for a shop: one order sends a
-- confirmation, a "how to pay", a shipped notice and a delivery slot, every
-- one with a subject of its own, and subject is the only thing the inbox could
-- thread them on. The module now says which conversation an email belongs to
-- ("shop-order:<id>") and this column is where that name is kept, so the next
-- email with the same name is filed underneath the first.
--
-- Scoped to an inbox, because the same name filed from two inboxes is two
-- conversations. Not unique: a race between two sends would otherwise fail the
-- filing, and two threads for a moment is a nuisance where a lost copy is not.

ALTER TABLE "uin_threads" ADD COLUMN IF NOT EXISTS "thread_key" TEXT;

CREATE INDEX IF NOT EXISTS "uin_threads_thread_key_idx"
  ON "uin_threads" ("inbox_id", "thread_key")
  WHERE "thread_key" IS NOT NULL;
