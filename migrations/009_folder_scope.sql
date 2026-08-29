-- Unified Inbox - Migration 009: keeping a shared mail account out of the site.
--
-- A NEW numbered file rather than an edit to an earlier one: a module migration
-- is recorded once per install and never runs again, so editing 001 reaches a
-- fresh install and nobody else. Everything below is idempotent, adds no table,
-- and contains no dollar-quoting anywhere - comments included - because the
-- backup round-trip harness skips a whole module whose migration files carry a
-- pair of them, which buys a green gate that proved nothing.
--
-- Both columns are BOOLEAN, a type this module already stores in five places,
-- so the schema-coverage backstop needs no new branch.
--
-- ---------------------------------------------------------------------------
-- The problem these two settings exist for.
--
-- A mail account is not always the site's own. Somebody points the inbox at the
-- account they already have, names the one folder their shop mail is filed
-- into, and reasonably expects to get that folder and nothing else. What they
-- got was the entire account: the reader adds INBOX, the archive and the sent
-- folder to every plan on purpose, because on a dedicated mailbox that is the
-- only way to catch mail somebody archived from their phone between two ticks.
-- On a personal account it is the way a bank, a doctor and a credit agency end
-- up in the shop's database, which nobody wanted and nobody asked for.
--
-- So the reading and the filing get a switch each, and both default to false:
-- an install that updates into these columns behaves exactly as it did the day
-- before, which is the only acceptable answer for a setting about somebody's
-- mail.
-- ---------------------------------------------------------------------------

-- Read nothing but the folders this account has actually been pointed at - the
-- ones named on the account itself, plus whatever folder each of its addresses
-- is set to. Off, the reader also takes INBOX, the archive and the sent folder,
-- which is right for a mailbox that exists to serve the site and wrong for one
-- that carries somebody's own post as well.
ALTER TABLE "uin_connections"
    ADD COLUMN IF NOT EXISTS "folders_only" BOOLEAN NOT NULL DEFAULT false;

-- Do not file mail that is addressed to none of this site's addresses. Off, it
-- is kept and shown in the Unrouted view, which is the cautious default and the
-- right one when a customer writes to an address nobody has configured yet.
-- On, it is dropped on the floor unread.
--
-- The reader only ever applies this to mail that starts a NEW conversation. A
-- message landing in a conversation already held is filed whatever its
-- addressing says, because a third party brought into an existing thread, or an
-- address that only appears in a Bcc, routes nowhere and is still plainly part
-- of the conversation. Dropping those would leave a thread that reads as though
-- somebody stopped replying halfway through.
ALTER TABLE "uin_connections"
    ADD COLUMN IF NOT EXISTS "discard_unrouted" BOOLEAN NOT NULL DEFAULT false;

-- No index is added, and that is a finding rather than an omission. Both
-- columns are read exactly once per account per tick, on a table that holds one
-- row per mail account - single figures on any site that will ever exist. An
-- index on a boolean over ten rows is a no-op that reads like work.
