-- ---------------------------------------------------------------------------
-- Forgiving search: half a word, and a word spelt wrong.
--
-- The search box matched whole words and nothing else. "invoi" found nothing,
-- and neither did "recieve" - which is the spelling somebody reaches for at
-- speed, and very often the spelling the customer used as well.
--
-- Half a word needs nothing here: lib/db.ts asks the existing full-text index
-- for every word as a prefix. A misspelt word is the part that needs this file.
-- Comparing what somebody typed against every email the site holds is far too
-- slow, and far too loose - a long message contains SOMETHING that looks a bit
-- like almost anything. So instead the site keeps a list of the words its mail
-- actually contains, and a word that is not on that list is swapped for the
-- few closest ones that are before the ordinary search runs. A word that IS on
-- the list is left alone, so "order" never starts finding "border".
--
-- Letters only, four to thirty of them. Numbers are never guessed at: somebody
-- searching PO-00025 wants that order and would be rightly annoyed to be shown
-- PO-00026 as well.
--
-- pg_trgm does the "closest" part. It is a trusted extension, so the database
-- owner may create it without a superuser, and every hosted Postgres this
-- platform has run on ships it.
--
-- The list is filled by lib/db.ts rather than by a trigger. A restore loads
-- this table and uin_messages in whatever order the backup holds them, and a
-- trigger on the messages would be writing into a table that was about to be
-- loaded - which fails on the first word both of them hold. So each message
-- carries a note of when its words were collected, the search collects any
-- that have not been, and a message whose text changes has its note cleared.
--
-- Idempotent throughout, and no dollar-quoted blocks anywhere in the file,
-- comments included. Only TEXT and TIMESTAMP(3), both already stored by this
-- module, so the schema-coverage backstop needs no new branch.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS "uin_search_terms" (
    -- Lower case, as to_tsvector('simple', ...) hands it over.
    "term" TEXT NOT NULL,

    CONSTRAINT "uin_search_terms_pkey" PRIMARY KEY ("term")
);

-- What makes "the closest words to this one" a lookup rather than a pass over
-- the whole list.
CREATE INDEX IF NOT EXISTS "uin_search_terms_trgm_idx"
    ON "uin_search_terms" USING GIN ("term" gin_trgm_ops);

-- Null until this message's words are on the list above.
ALTER TABLE "uin_messages" ADD COLUMN IF NOT EXISTS "search_terms_at" TIMESTAMP(3);

-- The few messages still to collect, found without reading all the rest.
CREATE INDEX IF NOT EXISTS "uin_messages_search_terms_todo_idx"
    ON "uin_messages" ("created_at")
 WHERE "search_terms_at" IS NULL;

-- Every message already held, collected now so the first search after this
-- update is as forgiving as every one after it.
INSERT INTO "uin_search_terms" ("term")
SELECT DISTINCT w
  FROM "uin_messages" m,
       unnest(tsvector_to_array(to_tsvector('simple',
         coalesce(m."subject", '') || ' ' ||
         coalesce(m."from_name", '') || ' ' ||
         coalesce(m."body_text", '')))) AS w
 WHERE m."search_terms_at" IS NULL
   AND length(w) BETWEEN 4 AND 30
   AND w !~ '[^[:alpha:]]'
ON CONFLICT ("term") DO NOTHING;

UPDATE "uin_messages"
   SET "search_terms_at" = CURRENT_TIMESTAMP
 WHERE "search_terms_at" IS NULL;
