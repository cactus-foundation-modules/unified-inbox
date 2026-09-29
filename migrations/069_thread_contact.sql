-- Unified Inbox - Migration 069: who a conversation is WITH, as somebody here
-- chose it.
--
-- A NEW numbered file, as every change in this module is: a migration is
-- recorded once per install and never runs again. Idempotent (ADD COLUMN IF NOT
-- EXISTS), free of dollar-quoted blocks - the backup round-trip harness skips
-- any module whose migration files contain a pair of them, comments included -
-- and text columns only, which the core backup serialiser already covers.
--
-- The name a row in the list shows is normally read off the newest message that
-- came in. That is right for a conversation that only ever happened one way,
-- and wrong for one that was merged together out of an email, a text and two
-- phone calls: whichever of those arrived last decided whether the row said
-- "Sam Jones" or "+447700900123", and it changed every time Sam rang.
--
-- So merging asks which of the people in front of it the merged conversation
-- is with, and the answer is kept here. Both null means nobody chose, and the
-- list goes on reading the newest message exactly as it always has.

ALTER TABLE "uin_threads" ADD COLUMN IF NOT EXISTS "contact_name" TEXT;
ALTER TABLE "uin_threads" ADD COLUMN IF NOT EXISTS "contact_address" TEXT;
