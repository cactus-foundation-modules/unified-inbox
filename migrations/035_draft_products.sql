-- ---------------------------------------------------------------------------
-- The products on a half-written message.
--
-- A message can now carry things out of the site's own catalogue - a product, a
-- listing that has variations, or one exact variation - and they are printed
-- under the writing when it goes out. A draft has to remember which ones, or a
-- quotation saved on Friday is a quotation to build again on Monday.
--
-- Deliberately REFERENCES and nothing else: a module name, what kind of thing
-- it is, and its id. No name, no price, no picture. Everything a customer reads
-- is fetched from the owning module at the moment the message is sent, so a
-- draft that sits in the list for a week goes out at this week's prices, and
-- nothing stored here can put words in the shop's mouth.
--
-- Idempotent, and a default of the empty list, so every draft written before
-- this simply carries no products.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_drafts"
    ADD COLUMN IF NOT EXISTS "products" JSONB NOT NULL DEFAULT '[]'::jsonb;
