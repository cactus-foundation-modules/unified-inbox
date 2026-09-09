-- Unified Inbox - Migration 050: noticing that a copied conversation has
-- changed without having gained a message.
--
-- Conversations owned by another module are copied across on a tick, and the
-- tick asks each channel for what has moved since the newest thing already
-- held. That question has always been "since it last got a MESSAGE", which is
-- wrong for anything a channel revises after the fact - and the telephony
-- channel does exactly that: a voicemail is typed up minutes after it was left,
-- and a recorded call minutes after it ended. The conversation gained nothing
-- new to say; what it already said simply became readable. Under the old rule
-- it was filtered out of the listing entirely and the words never arrived.
--
-- provider_content_at is the watermark for that second question, kept apart
-- from last_message_at so a revision never reorders the list as though somebody
-- had rung. NULL on every conversation collected before this existed, which
-- reads as "we have not been told", so the first pass after this lands re-reads
-- them once and then settles.
ALTER TABLE "uin_threads"
    ADD COLUMN IF NOT EXISTS "provider_content_at" TIMESTAMP(3);
