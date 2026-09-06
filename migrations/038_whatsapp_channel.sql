-- Unified Inbox - Migration 038: WhatsApp is a channel conversations arrive by.
--
-- The telephony module now publishes two channels rather than one: calls,
-- voicemail and texts under the phone one, and WhatsApp under its own, because
-- they are not the same thing to the person answering them - WhatsApp has its
-- own rules about when you may write at all and its own approved wording, and
-- filing it under the answerphone would hide both.
--
-- `channel` is checked in the schema rather than only in the code, which is the
-- right way round and is also why this file has to exist: without it every
-- WhatsApp conversation would be refused by Postgres at the moment it was
-- collected, and nothing in a typecheck, a lint or the test suite would have
-- said so - a CHECK constraint is a string to all three.
--
-- Idempotent: DROP ... IF EXISTS then ADD, so re-running it on an install that
-- already has it lands in the same place. 001_initial.sql carries the same list
-- for fresh installs, and the overlap is harmless for that reason.

ALTER TABLE "uin_threads" DROP CONSTRAINT IF EXISTS "uin_threads_channel_check";
ALTER TABLE "uin_threads" ADD CONSTRAINT "uin_threads_channel_check"
    CHECK ("channel" IN ('email', 'chat', 'form', 'phone', 'sms', 'whatsapp', 'discussion'));
