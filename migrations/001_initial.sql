-- Unified Inbox - initial migration
-- Table prefix: uin_
-- Applied once by the Cactus module migration runner during build.
-- Idempotent throughout: every statement is safe to re-run, so a site that
-- picks this file up twice (fresh install plus reconcile) is unharmed.
--
-- Column types are deliberately restricted to text / text[] / jsonb / boolean /
-- integer / timestamp(3), all of which the core backup serialiser already has a
-- branch for. Adding a type outside that set means extending lib/backup/serialize.ts
-- in the same change, or the export quietly stops being restorable.

-- ---------------------------------------------------------------------------
-- Connections - one real mail account. Several inboxes can hang off one of
-- these: a single iCloud account carrying half a dozen domain aliases is the
-- case this module was built for.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "uin_connections" (
    "id"                      TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "label"                   TEXT         NOT NULL,
    "imap_host"               TEXT         NOT NULL,
    "imap_port"               INTEGER      NOT NULL DEFAULT 993,
    "imap_username"           TEXT         NOT NULL,
    "imap_password_encrypted" TEXT,
    "imap_tls"                BOOLEAN      NOT NULL DEFAULT true,
    -- Folders the sync engine reads, over and above INBOX. Discovered by the
    -- Test connection button and editable by the owner; empty means "just the
    -- ones we can work out for ourselves".
    "extra_folders"           TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "last_sync_at"            TIMESTAMP(3),
    -- 'ok' | 'error' | NULL (never run)
    "last_sync_status"        TEXT,
    "last_sync_error"         TEXT,
    "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_connections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uin_connections_status_check" CHECK ("last_sync_status" IS NULL OR "last_sync_status" IN ('ok', 'error'))
);

-- ---------------------------------------------------------------------------
-- Inboxes - an address people write to. Not the same thing as a mail account:
-- hi@ and marcus@ can both be served by one connection, each with its own
-- staff, signature and sending identity.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "uin_inboxes" (
    "id"                       TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "name"                     TEXT         NOT NULL,
    -- Always stored lower case; routing compares lower case throughout.
    "address"                  TEXT         NOT NULL,
    "connection_id"            TEXT,
    "imap_folder"              TEXT         NOT NULL DEFAULT 'INBOX',
    "sent_folder"              TEXT,
    -- Anything that cannot be routed to a named address lands in the catch-all.
    "is_catch_all"             BOOLEAN      NOT NULL DEFAULT false,
    -- 'brevo' | 'smtp'
    "send_transport"           TEXT         NOT NULL DEFAULT 'brevo',
    -- NULL means "use the site's own Brevo key".
    "brevo_api_key_encrypted"  TEXT,
    "smtp_host"                TEXT,
    "smtp_port"                INTEGER,
    "smtp_username"            TEXT,
    "smtp_password_encrypted"  TEXT,
    "from_name"                TEXT,
    "signature_html"           TEXT,
    -- Copy replies into the real mailbox's Sent folder, so a phone's Mail app
    -- and the admin agree about what has been said.
    "append_to_sent"           BOOLEAN      NOT NULL DEFAULT false,
    "colour"                   TEXT,
    "sort_order"               INTEGER      NOT NULL DEFAULT 0,
    "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_inboxes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uin_inboxes_send_transport_check" CHECK ("send_transport" IN ('brevo', 'smtp')),
    CONSTRAINT "uin_inboxes_connection_fk"
        FOREIGN KEY ("connection_id") REFERENCES "uin_connections" ("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "uin_inboxes_address_key" ON "uin_inboxes" ("address");
CREATE INDEX IF NOT EXISTS "uin_inboxes_connection_idx" ON "uin_inboxes" ("connection_id");

-- ---------------------------------------------------------------------------
-- Per-inbox access. NO rows for an inbox means "anybody with unifiedinbox.view",
-- which is what an ordinary one-person site wants. The moment a single row
-- exists for an inbox, that list becomes the whole of the guest list - which is
-- how accounts@ stays away from the shop assistant.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "uin_inbox_access" (
    "inbox_id"   TEXT         NOT NULL,
    "user_id"    TEXT         NOT NULL,
    "can_reply"  BOOLEAN      NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_inbox_access_pkey" PRIMARY KEY ("inbox_id", "user_id"),
    CONSTRAINT "uin_inbox_access_inbox_fk"
        FOREIGN KEY ("inbox_id") REFERENCES "uin_inboxes" ("id") ON DELETE CASCADE,
    CONSTRAINT "uin_inbox_access_user_fk"
        FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "uin_inbox_access_user_idx" ON "uin_inbox_access" ("user_id");

-- ---------------------------------------------------------------------------
-- Organisations and people. Deliberately thin: this exists so two emails, a
-- chat and a phone call from the same human collapse into one story, and for
-- nothing else. It is not a CRM.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "uin_organisations" (
    "id"         TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "name"       TEXT         NOT NULL,
    "domain"     TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_organisations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "uin_organisations_domain_key" ON "uin_organisations" ("domain");

CREATE TABLE IF NOT EXISTS "uin_people" (
    "id"              TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "display_name"    TEXT,
    "primary_email"   TEXT,
    "organisation_id" TEXT,
    "notes"           TEXT,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_people_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uin_people_organisation_fk"
        FOREIGN KEY ("organisation_id") REFERENCES "uin_organisations" ("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "uin_people_organisation_idx" ON "uin_people" ("organisation_id");
CREATE INDEX IF NOT EXISTS "uin_people_primary_email_idx" ON "uin_people" ("primary_email");

-- Every way we know of reaching a person. `value` is normalised (lower-cased
-- email, digits-only phone) and unique across the table, which is what makes
-- "have we met this person before?" a single lookup.
CREATE TABLE IF NOT EXISTS "uin_person_identities" (
    "id"         TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "person_id"  TEXT         NOT NULL,
    -- 'email' | 'phone' | 'chat'
    "kind"       TEXT         NOT NULL,
    "value"      TEXT         NOT NULL,
    -- Where the identity came from: 'imap', 'provider', 'manual', ...
    "source"     TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_person_identities_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uin_person_identities_kind_check" CHECK ("kind" IN ('email', 'phone', 'chat')),
    CONSTRAINT "uin_person_identities_person_fk"
        FOREIGN KEY ("person_id") REFERENCES "uin_people" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "uin_person_identities_value_key" ON "uin_person_identities" ("value");
CREATE INDEX IF NOT EXISTS "uin_person_identities_person_idx" ON "uin_person_identities" ("person_id");

-- ---------------------------------------------------------------------------
-- Threads and messages.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "uin_threads" (
    "id"                 TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    -- NULL for channels somebody else owns (a chat, a form submission): those
    -- arrive through a provider and belong to no email address.
    "inbox_id"           TEXT,
    -- 'email' | 'chat' | 'form' | 'phone' | 'sms'
    "channel"            TEXT         NOT NULL DEFAULT 'email',
    "provider_module"    TEXT,
    "external_id"        TEXT,
    "subject"            TEXT,
    "subject_normalised" TEXT,
    "preview"            TEXT,
    -- 'open' | 'snoozed' | 'done'
    "status"             TEXT         NOT NULL DEFAULT 'open',
    "snooze_until"       TIMESTAMP(3),
    "assignee_user_id"   TEXT,
    "person_id"          TEXT,
    "organisation_id"    TEXT,
    "last_message_at"    TIMESTAMP(3),
    -- 'in' | 'out' | 'note'
    "last_direction"     TEXT,
    "unread"             BOOLEAN      NOT NULL DEFAULT true,
    "message_count"      INTEGER      NOT NULL DEFAULT 0,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_threads_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uin_threads_channel_check" CHECK ("channel" IN ('email', 'chat', 'form', 'phone', 'sms')),
    CONSTRAINT "uin_threads_status_check" CHECK ("status" IN ('open', 'snoozed', 'done')),
    CONSTRAINT "uin_threads_inbox_fk"
        FOREIGN KEY ("inbox_id") REFERENCES "uin_inboxes" ("id") ON DELETE SET NULL,
    CONSTRAINT "uin_threads_person_fk"
        FOREIGN KEY ("person_id") REFERENCES "uin_people" ("id") ON DELETE SET NULL,
    CONSTRAINT "uin_threads_organisation_fk"
        FOREIGN KEY ("organisation_id") REFERENCES "uin_organisations" ("id") ON DELETE SET NULL,
    CONSTRAINT "uin_threads_assignee_fk"
        FOREIGN KEY ("assignee_user_id") REFERENCES "User" ("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "uin_threads_inbox_last_message_idx"
    ON "uin_threads" ("inbox_id", "last_message_at" DESC);
CREATE INDEX IF NOT EXISTS "uin_threads_status_last_message_idx"
    ON "uin_threads" ("status", "last_message_at" DESC);
CREATE INDEX IF NOT EXISTS "uin_threads_person_idx" ON "uin_threads" ("person_id");
CREATE INDEX IF NOT EXISTS "uin_threads_assignee_idx" ON "uin_threads" ("assignee_user_id");
CREATE INDEX IF NOT EXISTS "uin_threads_subject_normalised_idx" ON "uin_threads" ("subject_normalised");
-- One thread per conversation a provider owns. Partial, because email threads
-- have neither column filled in and would otherwise all collide on (NULL, NULL).
CREATE UNIQUE INDEX IF NOT EXISTS "uin_threads_provider_external_key"
    ON "uin_threads" ("provider_module", "external_id")
    WHERE "provider_module" IS NOT NULL AND "external_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "uin_messages" (
    "id"                  TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "thread_id"           TEXT         NOT NULL,
    -- 'in' | 'out' | 'note'
    "direction"           TEXT         NOT NULL,
    "channel"             TEXT         NOT NULL DEFAULT 'email',
    -- RFC 5322 Message-ID, angle brackets stripped. THE identity of a message:
    -- the same mail seen in INBOX and in Archive is one message, not two.
    "message_id_header"   TEXT,
    "in_reply_to"         TEXT,
    "references_header"   TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "from_name"           TEXT,
    "from_address"        TEXT,
    "to_addresses"        TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "cc_addresses"        TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "subject"             TEXT,
    "body_text"           TEXT,
    "body_html"           TEXT,
    "snippet"             TEXT,
    "sent_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "has_attachments"     BOOLEAN      NOT NULL DEFAULT false,
    "size_bytes"          INTEGER,
    -- 'imap' | 'brevo' | 'provider' | 'manual'
    "source"              TEXT         NOT NULL DEFAULT 'imap',
    "provider_message_id" TEXT,
    -- 'sending' | 'sent' | 'failed' | NULL (nothing was sent)
    "delivery_status"     TEXT,
    "delivery_error"      TEXT,
    "author_user_id"      TEXT,
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uin_messages_source_check" CHECK ("source" IN ('imap', 'brevo', 'provider', 'manual')),
    CONSTRAINT "uin_messages_direction_check" CHECK ("direction" IN ('in', 'out', 'note')),
    CONSTRAINT "uin_messages_thread_fk"
        FOREIGN KEY ("thread_id") REFERENCES "uin_threads" ("id") ON DELETE CASCADE,
    CONSTRAINT "uin_messages_author_fk"
        FOREIGN KEY ("author_user_id") REFERENCES "User" ("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "uin_messages_thread_sent_idx" ON "uin_messages" ("thread_id", "sent_at");
CREATE INDEX IF NOT EXISTS "uin_messages_message_id_idx" ON "uin_messages" ("message_id_header");
CREATE INDEX IF NOT EXISTS "uin_messages_from_address_idx" ON "uin_messages" ("from_address");

-- Attachment metadata only. The bytes are fetched lazily on open and stored
-- under this module's own key prefix - never as a Media row, or a customer's
-- invoice from accounts@ would turn up in the media picker for anybody with
-- media permission.
CREATE TABLE IF NOT EXISTS "uin_attachments" (
    "id"           TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "message_id"   TEXT         NOT NULL,
    "filename"     TEXT         NOT NULL,
    "content_type" TEXT,
    "size_bytes"   INTEGER,
    -- Storage key once fetched; NULL until then.
    "media_key"    TEXT,
    "imap_part_id" TEXT,
    "fetched_at"   TIMESTAMP(3),
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_attachments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uin_attachments_message_fk"
        FOREIGN KEY ("message_id") REFERENCES "uin_messages" ("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "uin_attachments_message_idx" ON "uin_attachments" ("message_id");
CREATE INDEX IF NOT EXISTS "uin_attachments_media_key_idx" ON "uin_attachments" ("media_key");

-- ---------------------------------------------------------------------------
-- Soft pointers at other modules' records - an order, a purchase order, a bill.
-- Deliberately NO foreign keys out: a link has to survive the module that owns
-- the record being uninstalled, and renders as a dead label rather than an error.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "uin_record_links" (
    "id"          TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "person_id"   TEXT,
    "thread_id"   TEXT,
    "module_name" TEXT         NOT NULL,
    "record_type" TEXT         NOT NULL,
    "record_id"   TEXT         NOT NULL,
    "label"       TEXT,
    "confidence"  INTEGER      NOT NULL DEFAULT 100,
    -- 'auto' | 'user'
    "linked_by"   TEXT         NOT NULL DEFAULT 'auto',
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_record_links_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uin_record_links_linked_by_check" CHECK ("linked_by" IN ('auto', 'user')),
    CONSTRAINT "uin_record_links_person_fk"
        FOREIGN KEY ("person_id") REFERENCES "uin_people" ("id") ON DELETE CASCADE,
    CONSTRAINT "uin_record_links_thread_fk"
        FOREIGN KEY ("thread_id") REFERENCES "uin_threads" ("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "uin_record_links_person_idx" ON "uin_record_links" ("person_id");
CREATE INDEX IF NOT EXISTS "uin_record_links_thread_idx" ON "uin_record_links" ("thread_id");
CREATE INDEX IF NOT EXISTS "uin_record_links_record_idx"
    ON "uin_record_links" ("module_name", "record_type", "record_id");

-- ---------------------------------------------------------------------------
-- Sync bookkeeping. One row per folder we read, holding the cursors that make
-- an interrupted sync resumable rather than a fresh start.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "uin_sync_state" (
    "connection_id"        TEXT         NOT NULL,
    "folder"               TEXT         NOT NULL,
    -- Postgres INTEGER is not wide enough for an IMAP UIDVALIDITY, which is a
    -- 32-bit UNSIGNED value, so these are BIGINT.
    "uidvalidity"          BIGINT,
    "last_seen_uid"        BIGINT       NOT NULL DEFAULT 0,
    "backfill_cursor_uid"  BIGINT,
    "backfill_complete"    BOOLEAN      NOT NULL DEFAULT false,
    "last_run_at"          TIMESTAMP(3),
    "last_error"           TEXT,
    -- Held-until stamp for the per-connection lock: an hourly tick, a manual
    -- Check now and a Sent-folder append all want the same account, and iCloud
    -- caps concurrent connections.
    "locked_until"         TIMESTAMP(3),

    CONSTRAINT "uin_sync_state_pkey" PRIMARY KEY ("connection_id", "folder"),
    CONSTRAINT "uin_sync_state_connection_fk"
        FOREIGN KEY ("connection_id") REFERENCES "uin_connections" ("id") ON DELETE CASCADE
);

-- Which (folder, uid) locations have been read. Note this prevents re-READING a
-- location; it does not decide whether we already hold the message. That is
-- message_id_header's job - see uin_messages.
CREATE TABLE IF NOT EXISTS "uin_processed_messages" (
    "id"                TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "connection_id"     TEXT         NOT NULL,
    "folder"            TEXT         NOT NULL,
    "uid"               BIGINT       NOT NULL,
    "message_id_header" TEXT,
    "thread_id"         TEXT,
    "processed_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_processed_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uin_processed_messages_connection_fk"
        FOREIGN KEY ("connection_id") REFERENCES "uin_connections" ("id") ON DELETE CASCADE,
    CONSTRAINT "uin_processed_messages_thread_fk"
        FOREIGN KEY ("thread_id") REFERENCES "uin_threads" ("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "uin_processed_messages_location_key"
    ON "uin_processed_messages" ("connection_id", "folder", "uid");
CREATE INDEX IF NOT EXISTS "uin_processed_messages_message_id_idx"
    ON "uin_processed_messages" ("message_id_header");

-- ---------------------------------------------------------------------------
-- Audit trail: who assigned what to whom, and when.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "uin_events" (
    "id"         TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "thread_id"  TEXT         NOT NULL,
    "user_id"    TEXT,
    -- 'assigned' | 'snoozed' | 'status' | 'linked' | 'unlinked' | 'merged'
    "kind"       TEXT         NOT NULL,
    "detail"     JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uin_events_thread_fk"
        FOREIGN KEY ("thread_id") REFERENCES "uin_threads" ("id") ON DELETE CASCADE,
    CONSTRAINT "uin_events_user_fk"
        FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "uin_events_thread_idx" ON "uin_events" ("thread_id", "created_at");

-- ---------------------------------------------------------------------------
-- Module settings, singleton row.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "uin_settings" (
    "id"                TEXT         NOT NULL DEFAULT 'singleton',
    "backfill_months"   INTEGER      NOT NULL DEFAULT 12,
    "retention_months"  INTEGER,
    -- 'lazy' | 'always' | 'never'
    "attachment_fetch"  TEXT         NOT NULL DEFAULT 'lazy',
    "auto_link"         BOOLEAN      NOT NULL DEFAULT true,
    "default_inbox_id"  TEXT,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uin_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uin_settings_attachment_fetch_check" CHECK ("attachment_fetch" IN ('lazy', 'always', 'never')),
    CONSTRAINT "uin_settings_default_inbox_fk"
        FOREIGN KEY ("default_inbox_id") REFERENCES "uin_inboxes" ("id") ON DELETE SET NULL
);

INSERT INTO "uin_settings" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING;
