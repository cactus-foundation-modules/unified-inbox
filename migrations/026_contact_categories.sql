-- ---------------------------------------------------------------------------
-- S7: contact categories.
--
-- A label somebody puts on a contact - "Supplier", "Trade customer",
-- "Haulier", "Do not ring". The address book had a company and nothing else to
-- group by, and a company is not a category: a supplier and a customer can both
-- be at Acme Ltd, and the haulier who telephones has no company here at all.
--
-- Categories and NOT a pipeline, said once and meant: there is no order to
-- them beyond the one somebody drags them into, nothing moves between them on
-- its own, and no category means anything to any other part of the site. The
-- day one of them starts meaning "won" this has stopped being an address book.
--
-- Many to many, because a contact is legitimately two things at once. A site
-- that only ever puts one on each is a site that has used it that way, not a
-- rule this table imposes.
--
-- Idempotent throughout, and no dollar-quoted blocks anywhere in this file,
-- comments included: the backup round-trip harness skips any module whose
-- migrations contain one, and a skipped module is a green gate that proved
-- nothing about the tables below.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "uin_contact_categories" (
    "id"         TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "name"       TEXT         NOT NULL,
    -- Where it sits in the list somebody sees. Dragged into whatever order
    -- suits, the same as the addresses along the top of the hub.
    "sort_order" INTEGER      NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_contact_categories_pkey" PRIMARY KEY ("id")
);

-- One category per name, however it was typed. The import is what makes this
-- matter: a file with "Supplier" on one row and "supplier" on the next means
-- one category, and two would be a mess somebody has to unpick by hand.
CREATE UNIQUE INDEX IF NOT EXISTS "uin_contact_categories_name_key"
    ON "uin_contact_categories" (lower(btrim("name")));

CREATE INDEX IF NOT EXISTS "uin_contact_categories_order_idx"
    ON "uin_contact_categories" ("sort_order" ASC, "name" ASC);

-- Which contacts are in which. The primary key is the pair, so putting somebody
-- in a category they are already in changes nothing rather than growing a
-- second row - which is what an import run twice does on every line.
CREATE TABLE IF NOT EXISTS "uin_person_categories" (
    "person_id"   TEXT         NOT NULL,
    "category_id" TEXT         NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_person_categories_pkey" PRIMARY KEY ("person_id", "category_id"),
    CONSTRAINT "uin_person_categories_person_fk"
        FOREIGN KEY ("person_id") REFERENCES "uin_people" ("id") ON DELETE CASCADE,
    CONSTRAINT "uin_person_categories_category_fk"
        FOREIGN KEY ("category_id") REFERENCES "uin_contact_categories" ("id") ON DELETE CASCADE
);

-- Everybody in one category, which is what the filter on the contacts list
-- asks for. The pair's own key already answers the other direction.
CREATE INDEX IF NOT EXISTS "uin_person_categories_category_idx"
    ON "uin_person_categories" ("category_id");
