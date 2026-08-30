-- Unified Inbox Module - Migration 007: provider attachment URLs
--
-- Provider conversations (like Twilio voicemails) can include attachments that
-- are URLs rather than files to fetch. This adds an external_url column so
-- provider attachments can point directly to their source (e.g. an audio
-- recording proxy) without needing to be downloaded and stored locally.

ALTER TABLE "uin_attachments" ADD COLUMN IF NOT EXISTS "external_url" TEXT;
