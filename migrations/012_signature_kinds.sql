-- ---------------------------------------------------------------------------
-- Signatures, in whichever form the person writing one prefers: rich text,
-- pasted HTML, or built out of the email blocks in the page builder. The same
-- three the contact form's signatures use, rendered through the same core code,
-- so a site that has written one already knows exactly where it is.
--
-- Still one signature per inbox. An address has a signature; a person does not.
--
-- `signature_html` keeps its original meaning - the markup an inbox already
-- carries - which is why the kind column arrives defaulting to 'html': every
-- row that exists today holds HTML and must keep sending exactly what it sent
-- yesterday. New inboxes have nothing to preserve, so the default drops to
-- rich text afterwards, which is what somebody typing four lines wants.
-- ---------------------------------------------------------------------------

ALTER TABLE "uin_inboxes"
    ADD COLUMN IF NOT EXISTS "signature_kind" TEXT NOT NULL DEFAULT 'html',
    ADD COLUMN IF NOT EXISTS "signature"      TEXT,
    ADD COLUMN IF NOT EXISTS "signature_puck" JSONB;

ALTER TABLE "uin_inboxes"
    ALTER COLUMN "signature_kind" SET DEFAULT 'markdown';
