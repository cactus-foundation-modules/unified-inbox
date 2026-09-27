-- ---------------------------------------------------------------------------
-- Texts sent from an email conversation, and the replies that come back.
--
-- Somebody answering an email can send the customer a text from the same
-- screen (the dots beside Reply, when the contact has a mobile on their card).
-- The text is written onto that email conversation, and so is the customer's
-- reply when it arrives - it lands exactly where an email would have, waking
-- the conversation and standing down anything scheduled on it.
--
-- The texts themselves still belong to whichever module sends them, which
-- files every text with a number as one phone conversation. So this table is
-- the note that says "texts with this number, from this moment, belong on that
-- email conversation instead", read by the collecting pass (lib/text-links.ts).
--
-- One row per number: the conversation that texted them most recently is the
-- one their reply goes to. `ended_at` is set when somebody moves a reply out
-- to the Phone channel, which stops the redirecting without forgetting the row
-- - the collecting pass still needs to know that texts with this number may
-- already be filed somewhere other than the phone conversation, or it would
-- file them a second time.
--
-- Idempotent throughout, and no dollar-quoted blocks anywhere in the file,
-- comments included: the backup round-trip harness skips any module whose
-- migrations contain one. Only TEXT and TIMESTAMP(3), both already stored by
-- this module, so the schema-coverage backstop needs no new branch.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "uin_text_links" (
    -- E.164, the shape the telephony channel reports its party in.
    "phone"           TEXT         NOT NULL,
    "thread_id"       TEXT         NOT NULL,
    -- Texts with this number dated from here on are filed on the conversation
    -- above. Anything earlier stays wherever it already was.
    "since"           TIMESTAMP(3) NOT NULL,
    -- Set when a reply was moved out to the Phone channel. Nothing is
    -- redirected while it is set; sending another text clears it.
    "ended_at"        TIMESTAMP(3),
    -- Which channel, and which of its conversations, the redirected texts came
    -- from. Filled in the first time one is collected, and what moving a reply
    -- back out uses to find (or start) the phone conversation it belongs in.
    "provider_module" TEXT,
    "external_id"     TEXT,
    -- How far the collecting pass has read that phone conversation for this
    -- number. It stands in for the phone conversation's own watermark, which
    -- never moves while every new text is being filed elsewhere.
    "seen_through"    TIMESTAMP(3),
    "created_by"      TEXT,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "uin_text_links_pkey" PRIMARY KEY ("phone"),
    -- A conversation deleted for good takes its link with it; the texts that
    -- were on it went with it, and the next one from that number goes to the
    -- Phone channel as it always did.
    CONSTRAINT "uin_text_links_thread_fkey" FOREIGN KEY ("thread_id")
        REFERENCES "uin_threads"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "uin_text_links_thread_idx" ON "uin_text_links" ("thread_id");

-- "Do we already hold this channel message anywhere?" - asked of every message
-- in a phone conversation whose number has a link, because a text redirected to
-- an email conversation is not on the phone conversation the unique index
-- (thread_id, provider_message_id) is scoped to. The existing index on this
-- column (051) covers outbound messages only.
CREATE INDEX IF NOT EXISTS "uin_messages_provider_held_idx"
    ON "uin_messages" ("provider_module", "provider_message_id")
 WHERE "source" = 'provider' AND "provider_message_id" IS NOT NULL;
