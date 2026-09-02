-- Unified Inbox - Migration 015: remembering what the mail server said its
-- folders were called.
--
-- A NEW numbered file rather than an edit to an earlier one: a module migration
-- is recorded once per install and never runs again, so editing 001 reaches a
-- fresh install and nobody else. Everything below is idempotent, and there is
-- no dollar-quoting anywhere - comments included - because the backup
-- round-trip harness skips a whole module whose migration files carry a pair of
-- them, which buys a green gate that proved nothing.
--
-- JSONB and TIMESTAMP(3) are both stored by this module already, so the
-- schema-coverage backstop needs no new branch.
--
-- ---------------------------------------------------------------------------
-- Why the list is kept rather than fetched.
--
-- Setting an address up means naming the folder its mail is filed into, and
-- until now that meant typing it exactly as the server spells it - "Sent
-- Messages", not "Sent"; "INBOX.Suppliers", not "Suppliers". Get it wrong and
-- nothing says so: the folder simply never gets read.
--
-- The Test connection button has always asked the server for the list. It just
-- threw it away when the screen was closed. Keeping it means the folder boxes
-- can be a menu of the folders that actually exist, drawn the instant the
-- settings screen opens, with no mail server round-trip in the way. Refreshing
-- it stays an explicit button, because opening somebody's mailbox is not
-- something to do on a page load.
-- ---------------------------------------------------------------------------

-- What the server last said it had: an array of { path, name, specialUse, role }
-- objects, exactly as folder discovery returns them. NULL means nobody has ever
-- asked - which the screen tells apart from an account that answered with no
-- folders at all.
ALTER TABLE "uin_connections"
    ADD COLUMN IF NOT EXISTS "discovered_folders" JSONB;

-- When that list was taken, so the screen can say how old it is rather than
-- presenting a year-old menu as current.
ALTER TABLE "uin_connections"
    ADD COLUMN IF NOT EXISTS "folders_checked_at" TIMESTAMP(3);

-- No index, deliberately. Both columns are read by primary key on a table that
-- holds one row per mail account - single figures on any site that will ever
-- exist.
