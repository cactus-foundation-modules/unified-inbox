-- Unified Inbox - Migration 046: filing a module's sent mail is its own switch.
--
-- A NEW numbered file rather than an edit to 010, for the reason 010 itself
-- gives: a module migration is recorded once per install and never runs again,
-- so editing an earlier one reaches a fresh install and nobody else. Everything
-- below is idempotent, and there is no dollar-quoting anywhere - comments
-- included - because the backup round-trip harness skips a whole module whose
-- migration files carry a pair of them.
--
-- The one new column is TEXT, which this module already stores in a dozen
-- places, so the schema-coverage backstop needs no new branch.
--
-- ---------------------------------------------------------------------------
-- What this is for.
--
-- 010 gave a module one setting that quietly did two jobs: the inbox chosen for
-- it became the address that module's mail went out AS, and - since 044 - the
-- place a copy of that mail was filed, so a reply threads underneath what
-- prompted it.
--
-- Fine for purchase orders, where both answers are the same and always will be.
-- Not fine for a shop. Its order emails go out through the site's own sending
-- service and never touch a mail folder, so nobody can see what the customer
-- was actually told - but changing the address they go out AS is a
-- customer-facing decision an owner may not want to take just to get a copy
-- filed. Two questions wearing one control.
--
-- So they become two columns. Either may be set on its own:
--
--   inbox_id      - send this module's mail as that inbox. NULL: the site's
--                   usual address, exactly as before.
--   copy_inbox_id - file a copy of it there as a conversation. NULL: file
--                   nothing, exactly as before 044.
--
-- Nothing changes for a site that has already chosen: the UPDATE below copies
-- the sending inbox into the filing column, so every module filing today
-- carries on filing to the same place.
--
-- Both foreign keys become SET NULL rather than CASCADE. Deleting an inbox used
-- to take the whole row with it, which was right when the row held one answer
-- and wrong now that it holds two - losing where a module files because
-- somebody retired the address it sent from is a setting disappearing for no
-- reason anybody could see. A row left holding two NULLs is inert and gets
-- swept up the next time either setting is written.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_module_senders" ADD COLUMN IF NOT EXISTS "copy_inbox_id" TEXT;

-- A row may now say "file copies here and leave the sending address alone".
ALTER TABLE "uin_module_senders" ALTER COLUMN "inbox_id" DROP NOT NULL;

-- What a site running 044 or later already had: filing followed the sender.
UPDATE "uin_module_senders"
   SET "copy_inbox_id" = "inbox_id"
 WHERE "copy_inbox_id" IS NULL
   AND "inbox_id" IS NOT NULL;

-- DROP then ADD rather than a guarded block: ADD CONSTRAINT has no IF NOT
-- EXISTS, and this pair is idempotent without needing dollar quotes to say so.
ALTER TABLE "uin_module_senders" DROP CONSTRAINT IF EXISTS "uin_module_senders_inbox_fk";
ALTER TABLE "uin_module_senders"
    ADD CONSTRAINT "uin_module_senders_inbox_fk"
    FOREIGN KEY ("inbox_id") REFERENCES "uin_inboxes" ("id") ON DELETE SET NULL;

ALTER TABLE "uin_module_senders" DROP CONSTRAINT IF EXISTS "uin_module_senders_copy_inbox_fk";
ALTER TABLE "uin_module_senders"
    ADD CONSTRAINT "uin_module_senders_copy_inbox_fk"
    FOREIGN KEY ("copy_inbox_id") REFERENCES "uin_inboxes" ("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "uin_module_senders_copy_inbox_idx"
    ON "uin_module_senders" ("copy_inbox_id");
