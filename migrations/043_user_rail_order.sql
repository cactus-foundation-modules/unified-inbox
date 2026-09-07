-- Unified Inbox - Migration 043: the top of the rail, in one person's own order.
--
-- A NEW numbered file rather than an edit to an earlier one: a module migration
-- is recorded once per install and never runs again, so editing 017 would reach
-- a fresh install and nobody else. Everything below is idempotent, and there is
-- no dollar-quoting anywhere - comments included - because the backup
-- round-trip harness skips a whole module whose migration files carry a pair of
-- them, which buys a green gate that proved nothing.
--
-- TEXT[] and TIMESTAMP(3), both of which this module already stores, so the
-- backup serialiser and its schema-coverage backstop need no new branch.
--
-- ---------------------------------------------------------------------------
-- Three of the rail's groups could already be dragged into an order, and the
-- one people actually live in could not.
--
-- The reason it could not was a good one: the shared addresses, the colleagues'
-- inboxes and the channels are the SITE's, one arrangement for everybody, so
-- rearranging them takes the permission that looks after the place. "Yours" is
-- the opposite - their own address, All, what they have been tagged in, their
-- drafts, their sent, their bin - and the order those want to be in is a matter
-- of how one person works. Somebody who lives in Sent wants it second; somebody
-- who never opens it wants it last.
--
-- So this is a preference and it is stored like one: a row per person, keyed on
-- the person, saved without asking anybody's permission, and invisible to
-- everybody else. Exactly the shape 017 chose for the same reason.
--
-- The keys are what the rail calls its own entries - an inbox id for an
-- address, and the plain words 'all', 'mentions', 'drafts', 'sent' and 'spam'
-- for the rest. Nothing here checks them against anything: an id naming an
-- address somebody has since been taken off simply never matches an entry and
-- costs nothing, and an entry the order has never heard of - a folder added by
-- a later update - sorts after the ones it names, so a new place arrives at the
-- end of the group rather than in the middle of an arrangement somebody chose.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "uin_user_rail_order" (
    "user_id"    TEXT         NOT NULL,
    "keys"       TEXT[]       NOT NULL DEFAULT ARRAY[]::text[],
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_user_rail_order_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "uin_user_rail_order_user_fk"
        FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE
);
