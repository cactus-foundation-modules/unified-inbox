-- ---------------------------------------------------------------------------
-- One person's own inbox.
--
-- A shared hub with six addresses on it opens on All, which is the right answer
-- for whoever looks after the whole thing and the wrong one for the person who
-- only ever works purchasing@. So an address can be made somebody's own: it
-- sits first along the top, it is what they land on, and its signature is what
-- goes at the foot of their replies wherever they send them from.
--
-- One row per person, which is what the primary key on "user_id" alone says:
-- somebody's own inbox is one address or none, and moving it is an update
-- rather than a second row that would leave two answers to one question.
--
-- Deliberately NOT a column on "uin_inbox_access". An inbox with no access rows
-- is open to everybody (see lib/access.ts), so putting this there would mean
-- naming somebody's own inbox quietly restricted it to them - a guest list
-- created as a side effect of a preference. The two facts are separate, so the
-- tables are.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "uin_user_default_inbox" (
    "user_id"    TEXT         NOT NULL,
    "inbox_id"   TEXT         NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_user_default_inbox_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "uin_user_default_inbox_user_fk"
        FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE,
    CONSTRAINT "uin_user_default_inbox_inbox_fk"
        FOREIGN KEY ("inbox_id") REFERENCES "uin_inboxes" ("id") ON DELETE CASCADE
);

-- Asked from the inbox's side by the settings screen ("whose own inbox is
-- this?") as well as from the person's side on every page load of the hub.
CREATE INDEX IF NOT EXISTS "uin_user_default_inbox_inbox_idx"
    ON "uin_user_default_inbox" ("inbox_id");
