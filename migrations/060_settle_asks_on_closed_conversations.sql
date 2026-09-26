-- Unified Inbox - Migration 060: asks on conversations already closed are done.
--
-- A NEW numbered file rather than an edit to an earlier one: a module migration
-- is recorded once per install and never runs again. No dollar-quoting
-- anywhere, comments included, because the backup round-trip harness skips a
-- whole module whose migration files carry a pair of them. No schema change at
-- all - data only, and idempotent: a second run finds nothing left to settle.
--
-- Marking a conversation done used to leave the ask about it open, so the
-- Mentioned folder's Open tab went on listing work its owner had finished.
-- From this release, marking a conversation done settles your own ask on it
-- (settleOwnMentionOn in lib/db.ts). This tidies up what was left behind: an
-- open ask on a conversation that is done for everybody, or on a discussion its
-- owner closed for themselves (migrations/059), is settled.
--
-- Only OPEN asks. A snoozed one was deliberately put off by its owner and is
-- left exactly as it is.

UPDATE "uin_mentions" x
   SET "status" = 'done', "settled_at" = now(), "updated_at" = now()
 WHERE x."status" = 'open'
   AND EXISTS (
     SELECT 1 FROM "uin_threads" t
      WHERE t."id" = x."thread_id"
        AND (
          t."status" = 'done'
          OR (
            t."channel" = 'discussion'
            AND EXISTS (
              SELECT 1 FROM "uin_discussion_closures" dc
               WHERE dc."thread_id" = t."id" AND dc."user_id" = x."user_id"
            )
          )
        )
   );
