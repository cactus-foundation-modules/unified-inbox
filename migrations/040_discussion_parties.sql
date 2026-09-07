-- Unified Inbox - Migration 040: a discussion has a sender and people it is to.
--
-- A NEW numbered file rather than an edit to 030: a module migration is
-- recorded once per install and never runs again, so editing the earlier one
-- would reach a fresh install and nobody else. Everything below is idempotent,
-- and there is no dollar-quoting anywhere - comments included - because the
-- backup round-trip harness skips a whole module whose migration files carry a
-- pair of them, which buys a green gate that proved nothing.
--
-- TEXT and TEXT[] only, both of which this module already stores elsewhere, so
-- the backup serialiser and its schema-coverage backstop need no new branch.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS IS FOR
--
-- A discussion was started, filed in the starter's own address, and that was
-- the whole of what was recorded. Three things followed from that, and all
-- three were wrong in the same way: nothing said WHO it was between.
--
--   - The list had no sender to name. Every list row asks the newest message
--     that was not a note who the conversation is with, and every message on a
--     discussion IS a note - so the row said "Unknown sender" beside the
--     starter's own address, which reads as post from a stranger.
--
--   - The list had nobody to name at the other end either. It fell through to
--     "whose desk is it on", which on a discussion nobody has been handed is
--     the address it sits in - the starter's own. So a discussion Marcus
--     started read "Unknown sender > Marcus", with Marcus at the wrong end of
--     his own sentence and the people he was writing to nowhere on it.
--
--   - It never landed anywhere but the starter's address. Whoever it was put
--     to got a bell notice and a grant to read it, and no sign of it in the
--     post they actually look at.
--
-- So a discussion now says both halves out loud.
--
--   started_by_user_id  who started it. The list names them at the sending end,
--                       which is what it does for every other conversation.
--   to_user_ids         the colleagues it was put to, in the order they were
--                       added. The list names them at the receiving end.
--
-- People rather than addresses, deliberately. The To line on the compose form
-- asks for colleagues, not mailboxes, and a colleague who has not been given an
-- address of their own is still somebody a discussion can be put to - they
-- reach it through the ask on their own list. Which ADDRESSES hold it is a
-- consequence, written into uin_thread_inboxes (see 031_thread_merges.sql) so
-- that every list, tab, unread tally and guest list in this module reaches a
-- discussion by the one route they already use for a conversation belonging to
-- more than one address.
--
-- Both columns stay NULL / empty on every other channel: an email's two ends are
-- an outsider and one of our addresses, and neither is a colleague.
--
-- A discussion that ALREADY EXISTS is back-filled at the foot of this file,
-- because both halves of it were written down at the time under other names and
-- there is nothing to guess. Its opening internal note carries the author, who
-- is by definition whoever started it; the asks raised on that same note are the
-- people the To line named, because that is the only thing that put them there.
-- Without it, every discussion started before today would read "Unknown sender"
-- for the rest of its life, which is the defect this file exists to fix rather
-- than to fix from Tuesday onwards.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_threads" ADD COLUMN IF NOT EXISTS "started_by_user_id" TEXT;

-- SET NULL rather than CASCADE, the same answer this module gives everywhere a
-- staff account is pointed at: somebody leaving must not take the conversation
-- with them. A discussion whose starter has gone falls back to what the list
-- has always done with a name it does not have.
ALTER TABLE "uin_threads" DROP CONSTRAINT IF EXISTS "uin_threads_started_by_fk";
ALTER TABLE "uin_threads" ADD CONSTRAINT "uin_threads_started_by_fk"
    FOREIGN KEY ("started_by_user_id") REFERENCES "User" ("id") ON DELETE SET NULL;

-- Empty, never NULL, exactly as to_addresses already is on a message: a
-- discussion put to nobody is a note to self, which is a list of nobody rather
-- than an absent list, and every reader here is spared a coalesce.
--
-- No foreign key, because an array cannot carry one. A colleague whose account
-- has gone leaves an id that resolves to no name, and the list shows the names
-- it can resolve - the same answer it gives for an assignee who has left.
ALTER TABLE "uin_threads"
    ADD COLUMN IF NOT EXISTS "to_user_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- ---------------------------------------------------------------------------
-- The discussions that already exist.
--
-- All three statements are guarded so that running this file twice does the
-- work once: the first two only touch a row that has not been filled in yet,
-- and the third cannot write a row that is already there. Nothing here reads a
-- channel other than 'discussion', so ordinary post is not touched at all.
-- ---------------------------------------------------------------------------

-- Who started it: the author of the opening note. DISTINCT ON rather than a
-- correlated subquery per row, so this is one pass over the notes however many
-- conversations a site has. Ties broken on id, which only matters for two notes
-- written inside the same millisecond and makes the answer stable when they are.
UPDATE "uin_threads" t
   SET "started_by_user_id" = first_note."author_user_id"
  FROM (
    SELECT DISTINCT ON (m."thread_id")
           m."thread_id" AS "thread_id",
           m."author_user_id" AS "author_user_id"
      FROM "uin_messages" m
     WHERE m."direction" = 'note'
     ORDER BY m."thread_id", m."sent_at" ASC, m."id" ASC
  ) first_note
 WHERE t."id" = first_note."thread_id"
   AND t."channel" = 'discussion'
   AND t."started_by_user_id" IS NULL
   AND first_note."author_user_id" IS NOT NULL;

-- Who it was put to: the colleagues asked to look at the opening note. The To
-- line raised exactly one ask each, on that message and no other, so this is
-- the list as it was typed - and somebody tagged later, in a reply, is on a
-- different note and stays off it.
--
-- In the order they were asked, which is the order they were added.
UPDATE "uin_threads" t
   SET "to_user_ids" = asked."ids"
  FROM (
    SELECT n."thread_id" AS "thread_id",
           array_agg(n."user_id" ORDER BY n."created_at", n."id") AS "ids"
      FROM "uin_mentions" n
     WHERE n."message_id" = (
             SELECT m."id" FROM "uin_messages" m
              WHERE m."thread_id" = n."thread_id" AND m."direction" = 'note'
              ORDER BY m."sent_at" ASC, m."id" ASC
              LIMIT 1
           )
     GROUP BY n."thread_id"
  ) asked
 WHERE t."id" = asked."thread_id"
   AND t."channel" = 'discussion'
   AND cardinality(t."to_user_ids") = 0;

-- And file them where the two columns above now say they belong, so an old
-- discussion lands in the post of everybody it was put to exactly as a new one
-- does. Only ever their OWN address, and only where there is one - and the
-- conversation's own address goes on the list beside them, because that list is
-- read INSTEAD of "inbox_id" once it is not empty.
--
-- This widens nothing: every one of these people was already granted this one
-- conversation by the ask itself (see 032_mentions.sql), so it appears in a
-- mailbox they could already open it from.
INSERT INTO "uin_thread_inboxes" ("thread_id", "inbox_id")
SELECT rows."thread_id", rows."inbox_id"
  FROM (
    SELECT d."id" AS "thread_id", d."inbox_id" AS "inbox_id"
      FROM "uin_threads" d
     WHERE d."channel" = 'discussion'
       AND d."inbox_id" IS NOT NULL
       AND EXISTS (
             SELECT 1 FROM "uin_inboxes" i
              WHERE i."kind" = 'individual' AND i."owner_user_id" = ANY (d."to_user_ids")
           )
    UNION
    SELECT d."id" AS "thread_id", i."id" AS "inbox_id"
      FROM "uin_threads" d
      JOIN "uin_inboxes" i
        ON i."kind" = 'individual' AND i."owner_user_id" = ANY (d."to_user_ids")
     WHERE d."channel" = 'discussion'
  ) rows
ON CONFLICT DO NOTHING;
