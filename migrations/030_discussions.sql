-- Discussions: a conversation between colleagues that no customer ever sees.
--
-- The hub already had internal notes, but only ON something - a remark stuck to
-- a customer's email. There was no way to simply start one, and "have a word
-- about the Henderson order" is not a reply to anything. So a discussion is an
-- ordinary conversation in an ordinary inbox, with one difference: every
-- message on it is a note, nothing is ever sent anywhere, and the reply box
-- offers nothing that would leave the building.
--
-- It is a channel rather than a flag because that is what it is: a discussion
-- arrived by no channel at all, exactly as a text arrived by SMS and an enquiry
-- arrived by a form, and every list, badge and count in the module already
-- reads the channel to say where something came from.
--
-- Filed in one inbox, deliberately. The inbox is what decides who may read a
-- conversation (D16), and a discussion addressed to two of them would be a
-- conversation with two guest lists, two unread counts and one thread - so
-- naming several addresses starts one discussion in each, which is the same
-- answer this module already gives for an email between two of its own
-- addresses (see 020_internal_threads.sql).
--
-- Idempotent: DROP ... IF EXISTS then ADD, so re-running it on an install that
-- already has it lands in the same place.

ALTER TABLE "uin_threads" DROP CONSTRAINT IF EXISTS "uin_threads_channel_check";
ALTER TABLE "uin_threads" ADD CONSTRAINT "uin_threads_channel_check"
    CHECK ("channel" IN ('email', 'chat', 'form', 'phone', 'sms', 'discussion'));
