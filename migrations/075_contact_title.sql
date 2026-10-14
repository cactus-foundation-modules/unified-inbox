-- Unified Inbox - Migration 075: a contact's title (Mr, Mrs, Miss, Dr...).
--
-- A NEW numbered file, as every change in this module is. Idempotent, free of
-- dollar-quoted blocks, and a single text column the backup serialiser already
-- covers.
--
-- Sits before the first name on the card. It is kept apart from display_name on
-- purpose: display_name is the name everything shows and sorts on, and "Dr Jane
-- Smith" sorting under D is nobody's idea of an address book.

ALTER TABLE "uin_people" ADD COLUMN IF NOT EXISTS "title" TEXT;
