-- Conversations a channel ADDRESSED, and channels the owner would rather not see.
--
-- Until now a conversation another module owns - an enquiry, a chat, a call -
-- sat in no inbox at all, because none of them had an address to be filed by.
-- A form on the site does now: the person who built the page can say which of
-- the site's inboxes that particular form's enquiries belong in, and when they
-- have, the enquiry is ordinary filed post from the moment it arrives. Whoever
-- may read that inbox may read it; the inbox's unread count includes it; the
-- channel entry in the rail no longer carries it.
--
-- `source_label` is the other half of the same idea: WHAT it came from, in the
-- channel's own words - "Get in touch", "Request a quote". It is shown beside
-- the conversation the way an attached order is, and cannot be taken off,
-- because it is not something somebody attached: it is what the conversation
-- is.
--
-- Nothing here names a module. Both columns are filled from what a channel
-- reports about its own conversations, and stay NULL on every channel that
-- reports neither - which is all of them until one starts.

ALTER TABLE "uin_threads"
    ADD COLUMN IF NOT EXISTS "source_label" TEXT;

-- Channels the owner has switched off in Settings.
--
-- A site that routes every form into a real inbox does not want a second entry
-- in the rail listing the same enquiries again. Off is a deliberate act and an
-- empty array is the default, so nothing changes for anybody who never opens
-- the setting.
ALTER TABLE "uin_settings"
    ADD COLUMN IF NOT EXISTS "hidden_channel_modules" TEXT[] NOT NULL DEFAULT '{}'::text[];

-- The list and the counts both ask for "this inbox's conversations" and now get
-- provider-owned ones among them, which on a busy site is the difference
-- between a scan and an index read.
CREATE INDEX IF NOT EXISTS "uin_threads_provider_inbox_idx"
    ON "uin_threads" ("provider_module", "inbox_id")
    WHERE "provider_module" IS NOT NULL;
