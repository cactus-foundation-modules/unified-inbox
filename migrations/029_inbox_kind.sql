-- Unified Inbox - Migration 029: an inbox is either one person's or the team's.
--
-- A NEW numbered file rather than an edit to an earlier one: a module migration
-- is recorded once per install and never runs again, so editing 001 reaches a
-- fresh install and nobody else. Everything below is idempotent, and there is
-- no dollar-quoting anywhere - comments included - because the backup
-- round-trip harness skips a whole module whose migration files carry a pair of
-- them, which buys a green gate that proved nothing.
--
-- TEXT only, so the backup serialiser and its schema-coverage backstop need no
-- new branch.
--
-- WHAT THIS IS
--
-- Until now every address was the same kind of thing, and who could read it was
-- said entirely in the guest list: no rows meant everybody, some rows meant
-- those people. That answers "who is on support@" perfectly well and answers
-- "is marcus@ his own post or the team's?" not at all.
--
--   shared      - an address the business owns. sales@, accounts@, hello@.
--                 The guest list decides, exactly as before. Conversations are
--                 handed round, and whoever looks after the site can read it.
--
--   individual  - one person's own post at work. Nobody else opens it: not a
--                 colleague, not an administrator. Somebody who administers the
--                 site can rename it, re-point it or delete it, and still
--                 cannot read a word of it, which is the entire point of the
--                 distinction and the one place in this module where `manage`
--                 is not a way past a list.
--
-- NOTHING IS CONVERTED BY THIS FILE. Every address on every existing install
-- becomes 'shared', which is what they all already behaved as. Turning one into
-- somebody's own is a deliberate act in Settings, because it takes an address
-- away from people who can read it today - and a migration that quietly hid
-- half the post from the person who set the site up would be a support call,
-- not an upgrade.

-- 'individual' | 'shared'. Shared for everything that already exists.
ALTER TABLE "uin_inboxes" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'shared';

-- Whose post it is, on an individual inbox. NULL on a shared one, and NULL on
-- an individual one whose owner's account has since been deleted - see the FK
-- below. Left deliberately nullable rather than made part of the CHECK: an
-- owner leaving the company must not be a constraint violation on a table
-- nobody is writing to at the time.
ALTER TABLE "uin_inboxes" ADD COLUMN IF NOT EXISTS "owner_user_id" TEXT;

-- Dropped and re-added rather than guarded with a DO block: a pair of dollar
-- quotes anywhere in this file takes the whole module out of the backup
-- round-trip, and this says the same thing without them.
ALTER TABLE "uin_inboxes" DROP CONSTRAINT IF EXISTS "uin_inboxes_kind_check";
ALTER TABLE "uin_inboxes" ADD CONSTRAINT "uin_inboxes_kind_check"
    CHECK ("kind" IN ('individual', 'shared'));

-- SET NULL rather than CASCADE. Deleting somebody's staff account must not take
-- their mailbox and every conversation in it with it - the address stops being
-- anybody's, the post stays, and only an administrator can then see it, which
-- is the same answer this module already gives for mail it cannot place.
ALTER TABLE "uin_inboxes" DROP CONSTRAINT IF EXISTS "uin_inboxes_owner_fk";
ALTER TABLE "uin_inboxes" ADD CONSTRAINT "uin_inboxes_owner_fk"
    FOREIGN KEY ("owner_user_id") REFERENCES "User" ("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "uin_inboxes_owner_idx" ON "uin_inboxes" ("owner_user_id");
