-- ---------------------------------------------------------------------------
-- "Everything in this folder is mine."
--
-- Routing has always been by address: Delivered-To, then To, then Cc, then the
-- catch-all. That is right for a mailbox where the server sorts the post, and
-- wrong for the case an owner runs into the first week they use this - they
-- drag an email into the purchasing@ folder by hand, it was addressed to some
-- older address of theirs, and it lands in Not filed instead of Purchasing.
--
-- With this on, an inbox claims everything sitting in the folder it reads,
-- whoever it was addressed to. Off by default: an account that has never been
-- told otherwise routes exactly as it did yesterday.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_inboxes"
    ADD COLUMN IF NOT EXISTS "folder_owns_mail" BOOLEAN NOT NULL DEFAULT false;
