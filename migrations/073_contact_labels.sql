-- Unified Inbox - Migration 073: labels on a contact's numbers and addresses.
--
-- A NEW numbered file, as every change in this module is. Idempotent, free of
-- dollar-quoted blocks, and only plain text, timestamp and integer columns the
-- backup serialiser already covers.
--
-- A customer has an order phone and a delivery phone, and a billing address and
-- a delivery address, and a card that holds one of each cannot say which it is
-- holding. So:
--
--   * a way of reaching somebody (an address or a number) can carry a label -
--     "Order", "Delivery" - in `uin_person_identities`.label;
--   * the address that has always lived in the person's own columns keeps doing
--     so, and gets a label of its own in `uin_people`.address_label;
--   * any further address lives in its own table, one row each, with a label.

ALTER TABLE "uin_person_identities" ADD COLUMN IF NOT EXISTS "label" TEXT;

ALTER TABLE "uin_people" ADD COLUMN IF NOT EXISTS "address_label" TEXT;

CREATE TABLE IF NOT EXISTS "uin_person_addresses" (
    "id"               TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "person_id"        TEXT NOT NULL,
    "label"            TEXT,
    "address_line1"    TEXT,
    "address_line2"    TEXT,
    "address_city"     TEXT,
    "address_county"   TEXT,
    "address_postcode" TEXT,
    "address_country"  TEXT,
    "position"         INTEGER NOT NULL DEFAULT 0,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "uin_person_addresses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uin_person_addresses_person_fk"
        FOREIGN KEY ("person_id") REFERENCES "uin_people" ("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "uin_person_addresses_person_idx"
    ON "uin_person_addresses" ("person_id", "position");
