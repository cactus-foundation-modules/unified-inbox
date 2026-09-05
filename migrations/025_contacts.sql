-- ---------------------------------------------------------------------------
-- S7: contacts.
--
-- The people layer was built thin on purpose, and stayed thin for good reason:
-- it existed so that two emails, a live chat and a phone call from one human
-- collapse into one story, and a directory of everybody who has ever written in
-- is how a conversation hub quietly turns into a customer database.
--
-- What it could never do was hold what somebody actually knows about a contact.
-- A supplier's landline, the name of the person who answers it, and where to
-- post a cheque are things a site owner writes on the back of an envelope
-- today, because the hub had nowhere to put them. That is not a pipeline and it
-- is not a score - it is an address book, and every business has one.
--
-- So this file adds the fields an address book has and nothing else. There is
-- still no stage, no value, no next action and no forecast, and there is still
-- not going to be.
--
-- Idempotent throughout, and no dollar-quoted blocks anywhere in the file,
-- comments included: the backup round-trip harness skips any module whose
-- migrations contain one, and a skipped module is a green gate that proved
-- nothing about the columns below.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- A person, as an address book holds one.
--
-- `display_name` stays the name everything shows, because everything already
-- shows it and a second answer to "what is this person called" is a second
-- answer that can disagree. First and last are what somebody types and what the
-- list sorts on; the code keeps display_name in step with them on every save.
--
-- Phone numbers are deliberately NOT a column here. They belong in
-- uin_person_identities alongside the addresses, which is what makes a number
-- typed into a contact card recognise the caller it rings in from - the entire
-- point of the identities table. A `phone` column beside it would be a second
-- place to look and the two would drift within a week.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_people" ADD COLUMN IF NOT EXISTS "first_name" TEXT;
ALTER TABLE "uin_people" ADD COLUMN IF NOT EXISTS "last_name" TEXT;
ALTER TABLE "uin_people" ADD COLUMN IF NOT EXISTS "job_title" TEXT;
ALTER TABLE "uin_people" ADD COLUMN IF NOT EXISTS "website" TEXT;

-- A postal address, in the parts a British envelope has. Split rather than one
-- free-text box because a postcode somebody can search on is worth having, and
-- because a label printed from one box is a label with the town in the wrong
-- place.
ALTER TABLE "uin_people" ADD COLUMN IF NOT EXISTS "address_line1" TEXT;
ALTER TABLE "uin_people" ADD COLUMN IF NOT EXISTS "address_line2" TEXT;
ALTER TABLE "uin_people" ADD COLUMN IF NOT EXISTS "address_city" TEXT;
ALTER TABLE "uin_people" ADD COLUMN IF NOT EXISTS "address_county" TEXT;
ALTER TABLE "uin_people" ADD COLUMN IF NOT EXISTS "address_postcode" TEXT;
ALTER TABLE "uin_people" ADD COLUMN IF NOT EXISTS "address_country" TEXT;

-- Where the record came from. Everything already in the table was worked out
-- from the post, which is what the default says, and it is worth knowing: a
-- contact somebody typed by hand is one they meant, and a contact the mail
-- pass invented from a From line is a guess that may want tidying up.
ALTER TABLE "uin_people" ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'mail';

ALTER TABLE "uin_people" DROP CONSTRAINT IF EXISTS "uin_people_origin_check";
ALTER TABLE "uin_people" ADD CONSTRAINT "uin_people_origin_check"
    CHECK ("origin" IN ('mail', 'hand', 'import'));

-- The contacts list sorts by surname, which is what an address book does.
CREATE INDEX IF NOT EXISTS "uin_people_name_idx"
    ON "uin_people" ("last_name" ASC, "first_name" ASC);

-- Everybody already here has a name that was guessed from their address or read
-- off a From line, and the guesser produces "Jane Smith" - two title-cased
-- words. Those split cleanly and are worth splitting, so the contacts list has
-- something to sort by on the day the screen arrives rather than a column of
-- blanks. Anything longer, shorter or with an @ in it is left exactly as it is:
-- "Deskwell Office Furniture Ltd" has no surname and inventing one is worse
-- than leaving the boxes empty for somebody to fill in.
UPDATE "uin_people"
   SET "first_name" = split_part(btrim("display_name"), ' ', 1),
       "last_name"  = split_part(btrim("display_name"), ' ', 2)
 WHERE "first_name" IS NULL
   AND "last_name" IS NULL
   AND "display_name" IS NOT NULL
   AND "display_name" NOT LIKE '%@%'
   AND array_length(string_to_array(btrim("display_name"), ' '), 1) = 2;

-- ---------------------------------------------------------------------------
-- An organisation, as an address book holds one.
--
-- `domain` stays unique and stays the thing the mail pass matches on. An
-- organisation somebody adds by hand has no domain at all, which Postgres is
-- perfectly happy with - NULLs do not collide in a unique index - and which is
-- right: the haulier who only ever telephones has no mail domain to know.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_organisations" ADD COLUMN IF NOT EXISTS "email" TEXT;
ALTER TABLE "uin_organisations" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "uin_organisations" ADD COLUMN IF NOT EXISTS "website" TEXT;
ALTER TABLE "uin_organisations" ADD COLUMN IF NOT EXISTS "notes" TEXT;

ALTER TABLE "uin_organisations" ADD COLUMN IF NOT EXISTS "address_line1" TEXT;
ALTER TABLE "uin_organisations" ADD COLUMN IF NOT EXISTS "address_line2" TEXT;
ALTER TABLE "uin_organisations" ADD COLUMN IF NOT EXISTS "address_city" TEXT;
ALTER TABLE "uin_organisations" ADD COLUMN IF NOT EXISTS "address_county" TEXT;
ALTER TABLE "uin_organisations" ADD COLUMN IF NOT EXISTS "address_postcode" TEXT;
ALTER TABLE "uin_organisations" ADD COLUMN IF NOT EXISTS "address_country" TEXT;

ALTER TABLE "uin_organisations" ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'mail';

ALTER TABLE "uin_organisations" DROP CONSTRAINT IF EXISTS "uin_organisations_origin_check";
ALTER TABLE "uin_organisations" ADD CONSTRAINT "uin_organisations_origin_check"
    CHECK ("origin" IN ('mail', 'hand', 'import'));

-- Picking an organisation out of a menu is a search by name, and a site with a
-- few thousand of them should not read the table to answer it.
CREATE INDEX IF NOT EXISTS "uin_organisations_name_idx" ON "uin_organisations" ("name" ASC);
