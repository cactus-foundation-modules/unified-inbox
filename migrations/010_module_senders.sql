-- Unified Inbox - Migration 010: which inbox a module's own emails leave as.
--
-- A NEW numbered file rather than an edit to an earlier one: a module migration
-- is recorded once per install and never runs again, so editing 001 reaches a
-- fresh install and nobody else. Everything below is idempotent, and there is no
-- dollar-quoting anywhere - comments included - because the backup round-trip
-- harness skips a whole module whose migration files carry a pair of them, which
-- buys a green gate that proved nothing.
--
-- Every column here is TEXT or TIMESTAMP(3), both of which this module already
-- stores in a dozen places, so the schema-coverage backstop needs no new branch.
--
-- ---------------------------------------------------------------------------
-- What this is for.
--
-- Purchase Orders emails a supplier. The shop emails a customer to say their
-- order is on its way. Both go out as the site's one address, because that is
-- all core has ever had, and both are then replied to - to that same address,
-- where whoever reads the site's general post now has a delivery question and a
-- supplier's proforma to forward on.
--
-- A site running this module has already said, in its own words, that
-- orders@ is one thing and accounts@ is another. So it may now say which of
-- them a given module's mail leaves as, and the answer comes back to the inbox
-- the people who deal with it are already reading.
--
-- One row per module, module_name as the key: a module has one sending
-- identity, and a site that has not chosen one simply has no row and keeps
-- exactly what it had before.
--
-- ON DELETE CASCADE, deliberately. Deleting an inbox is a site saying that
-- address is finished, and the right thing for a module still pointed at it is
-- to fall straight back to the site's own address rather than fail to send.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "uin_module_senders" (
    "module_name" TEXT         NOT NULL,
    "inbox_id"    TEXT         NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_module_senders_pkey" PRIMARY KEY ("module_name"),
    CONSTRAINT "uin_module_senders_inbox_fk"
        FOREIGN KEY ("inbox_id") REFERENCES "uin_inboxes" ("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "uin_module_senders_inbox_idx"
    ON "uin_module_senders" ("inbox_id");
