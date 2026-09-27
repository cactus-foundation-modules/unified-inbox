-- Unified Inbox - Migration 062: a customer's email copied to two of our
-- addresses shows in both.
--
-- A NEW numbered file, as every change in this module is: a migration is
-- recorded once per install and never runs again, so editing an earlier one
-- reaches a fresh install and nobody else. It adds no table and no column - it
-- writes rows into uin_thread_inboxes (031_thread_merges.sql), whose types the
-- backup serialiser already covers. Idempotent: ON CONFLICT DO NOTHING, so an
-- install that runs it twice is unharmed. No dollar-quoting anywhere, comments
-- included, because the backup round-trip harness skips a whole module whose
-- migration files carry a pair of them.
--
-- ---------------------------------------------------------------------------
-- What went wrong.
--
-- An outsider wrote to hi@ and copied emma@ in. The mail server put a copy in
-- both mailboxes; the reader picked ONE home for the conversation (the To line
-- wins) and recognised the second copy as the same message, so Emma's tab never
-- showed it. Seen on the live site on 27 September 2026.
--
-- The reader now files such a conversation under every one of our addresses
-- the email names, through the same table a merge and a discussion already use
-- to belong to several addresses. This file does the same for conversations
-- collected before it, reading the To and Cc lines already stored (Delivered-To
-- is not stored, so a Bcc'd address is not recovered here - the reader picks
-- those up from the copy's own headers from now on).
--
-- Left alone, deliberately:
--   - mail from one of our own addresses: colleague mail is already split into
--     a conversation per side by 020_internal_threads.sql;
--   - a conversation somebody has moved to another address - moving it is
--     somebody saying where it lives, and this would undo that;
--   - one that lost a merge, one with no home address, and refused post.
-- ---------------------------------------------------------------------------

WITH named AS (
    SELECT m."thread_id", m."id" AS message_id, i."id" AS inbox_id
      FROM "uin_messages" m
      JOIN "uin_inboxes" i
        ON i."connection_id" = m."connection_id"
       AND lower(i."address") = ANY (
             SELECT lower(a) FROM unnest(m."to_addresses" || m."cc_addresses") AS a
           )
     WHERE m."channel" = 'email'
       AND m."direction" = 'in'
       AND m."connection_id" IS NOT NULL
       AND NOT EXISTS (
             SELECT 1 FROM "uin_inboxes" s WHERE lower(s."address") = lower(m."from_address")
           )
),
several AS (
    -- Only the messages that name two or more of our addresses.
    SELECT n."thread_id", n."inbox_id"
      FROM named n
     WHERE n."message_id" IN (
             SELECT "message_id" FROM named GROUP BY "message_id" HAVING count(DISTINCT "inbox_id") > 1
           )
),
eligible AS (
    SELECT t."id", t."inbox_id"
      FROM "uin_threads" t
     WHERE t."inbox_id" IS NOT NULL
       AND t."merged_into_id" IS NULL
       AND t."blocked_at" IS NULL
       AND NOT EXISTS (SELECT 1 FROM "uin_events" e WHERE e."thread_id" = t."id" AND e."kind" = 'moved')
       AND EXISTS (SELECT 1 FROM several s WHERE s."thread_id" = t."id" AND s."inbox_id" <> t."inbox_id")
)
-- The home address goes in with the others: once a conversation has rows here
-- they are read INSTEAD of its inbox_id, so leaving it out would take the
-- conversation out of the tab it lives in.
INSERT INTO "uin_thread_inboxes" ("thread_id", "inbox_id")
SELECT e."id", e."inbox_id" FROM eligible e
UNION
SELECT s."thread_id", s."inbox_id" FROM several s JOIN eligible e ON e."id" = s."thread_id"
ON CONFLICT DO NOTHING;
