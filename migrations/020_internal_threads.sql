-- Mail between two of our own addresses is one email and two conversations.
--
-- Until now it was one of each. The first copy met - the sender's Sent folder
-- or the recipient's own folder, whichever the sweep reached first - was filed
-- once, on one inbox, and the other address never saw it. Worse, a reply
-- threaded onto that same conversation by In-Reply-To, so answering a colleague
-- put the answer in the sender's tab and nowhere near the person it was
-- addressed to.
--
-- Marcus writing to Chris is now Marcus's sent message on Marcus's conversation
-- AND Chris's received one on Chris's, each with its own read state, snooze and
-- assignee, exactly as a customer's email has.
--
-- Idempotent throughout: every statement is guarded, so re-running it on an
-- install that already has it is a no-op.

-- ---------------------------------------------------------------------------
-- 1. One message may now sit on two threads.
-- ---------------------------------------------------------------------------

-- The old key allowed a message once per account, which is precisely what
-- collapsed the two sides into one. The thread joins the key; the guard against
-- filing the same mail twice ON ONE THREAD is unchanged.
CREATE UNIQUE INDEX IF NOT EXISTS "uin_messages_connection_thread_message_id_key"
    ON "uin_messages" ("connection_id", "thread_id", "message_id_header")
 WHERE "connection_id" IS NOT NULL AND "message_id_header" IS NOT NULL;

DROP INDEX IF EXISTS "uin_messages_connection_message_id_key";

-- ---------------------------------------------------------------------------
-- 2. Recognising the second copy when the Message-ID was rewritten in transit.
-- ---------------------------------------------------------------------------

-- A message sent through a relay comes back from the recipient's folder with an
-- id we have never seen, so the header cannot tell us it is the copy we already
-- hold. This is built from what a relay does not touch - when it was sent, who
-- sent it, what it was about - and stops that copy being filed as a second
-- message on the same conversation.
ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "internal_key" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "uin_messages_thread_internal_key"
    ON "uin_messages" ("thread_id", "internal_key")
 WHERE "internal_key" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Letting the sweep meet the internal mail it has already walked past.
-- ---------------------------------------------------------------------------

-- Filing the missing side happens in the reader, which only ever looks at mail
-- it has not read before. Every internal message already collected would
-- therefore stay one-sided for ever. Winding each affected folder's cursor back
-- to just before its oldest internal message makes the next tick read them
-- again, and re-reading is the one thing this module is built to survive: a
-- message already held is recognised and only its missing side is written.
--
-- Scoped as tightly as it can be. A folder with no internal mail in it is left
-- exactly where it was, so this costs nothing on a site whose staff do not
-- email each other.
WITH internal AS (
    SELECT m."connection_id",
           m."imap_folder"      AS folder,
           MIN(m."imap_uid")    AS oldest_uid
      FROM "uin_messages" m
      JOIN "uin_inboxes" sender ON lower(sender."address") = lower(m."from_address")
     WHERE m."channel" = 'email'
       AND m."connection_id" IS NOT NULL
       AND m."imap_folder" IS NOT NULL
       AND m."imap_uid" IS NOT NULL
       AND EXISTS (
             SELECT 1 FROM "uin_inboxes" recipient
              WHERE recipient."id" <> sender."id"
                AND lower(recipient."address") = ANY (
                      SELECT lower(a) FROM unnest(m."to_addresses" || m."cc_addresses") AS a
                    )
           )
     GROUP BY m."connection_id", m."imap_folder"
)
UPDATE "uin_sync_state" s
   SET "last_seen_uid" = LEAST(s."last_seen_uid", GREATEST(internal.oldest_uid - 1, 0))
  FROM internal
 WHERE s."connection_id" = internal."connection_id"
   AND s."folder" = internal.folder
   AND s."last_seen_uid" > GREATEST(internal.oldest_uid - 1, 0);
