-- ---------------------------------------------------------------------------
-- Shop customers in the address book.
--
-- When the shop is installed alongside this module, somebody who pays for an
-- order becomes a contact: their name, their email address, their phone number,
-- the company they bought for and the address the invoice goes to. The work is
-- all on this side (lib/shop-customer-sync.ts, listening on the shop's own
-- `shop.order-paid` announcement) and the shop is not touched - a site running
-- the shop without this module carries none of it.
--
-- Idempotent throughout, and no dollar-quoted blocks anywhere in the file,
-- comments included: the backup round-trip harness skips any module whose
-- migrations contain one, and a skipped module is a green gate that proved
-- nothing about the columns below.
--
-- BOOLEAN is already stored by this module (auto_link, show_avatars), so the
-- schema-coverage backstop needs no new branch.
-- ---------------------------------------------------------------------------

-- Whether a paid order adds its customer to the contacts.
--
-- TRUE, and true for every install that takes this update. The deliberate
-- exception to this module's "a new switch arrives off" rule, and for the same
-- reason auto_assign_own_post is one: nothing is sent anywhere and nobody else
-- is told anything. The details are the ones the customer typed into this same
-- site's checkout, copied from one of its own tables into another. The switch
-- is there for the site that would rather keep its address book to the people
-- it has chosen to put in it.
ALTER TABLE "uin_settings" ADD COLUMN IF NOT EXISTS "shop_customer_contacts" BOOLEAN NOT NULL DEFAULT TRUE;

-- Where a record came from gains a fourth answer: a paid order. Neither a guess
-- from a From line nor something typed on this screen, and worth telling apart
-- from both - it is what the customer said about themselves at the checkout.
--
-- Dropped and re-added rather than altered, which is the only way a CHECK can
-- be widened, and is what makes running this file twice harmless.
ALTER TABLE "uin_people" DROP CONSTRAINT IF EXISTS "uin_people_origin_check";
ALTER TABLE "uin_people" ADD CONSTRAINT "uin_people_origin_check"
    CHECK ("origin" IN ('mail', 'hand', 'import', 'order'));

ALTER TABLE "uin_organisations" DROP CONSTRAINT IF EXISTS "uin_organisations_origin_check";
ALTER TABLE "uin_organisations" ADD CONSTRAINT "uin_organisations_origin_check"
    CHECK ("origin" IN ('mail', 'hand', 'import', 'order'));
