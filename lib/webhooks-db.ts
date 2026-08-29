import { prisma } from '@/lib/db/prisma'
import { encryptSecret, tryDecryptSecret } from '@/lib/crypto/secrets'
import type {
  Webhook,
  WebhookDelivery,
  WebhookEvent,
  WebhookInput,
  WebhookPatch,
  WebhookSecrets,
} from './webhook-types'

// ---------------------------------------------------------------------------
// Every read and write against the two webhook tables lives here, in its own
// file rather than in db.ts: this arrived after the rest of the module and
// nothing else needs to know the column names.
//
// The rule db.ts follows applies here too - a secret goes in as plaintext and
// comes back as a boolean. The screen only ever needs to know whether one is
// set, and a signing secret that reaches the browser is a signing secret that
// reaches anybody who can read a network tab.
// ---------------------------------------------------------------------------

function mapWebhook(r: Record<string, unknown>): Webhook {
  return {
    id: r.id as string,
    name: r.name as string,
    inboxId: (r.inbox_id as string | null) ?? null,
    url: r.url as string,
    enabled: !!r.enabled,
    events: ((r.events as string[] | null) ?? []) as WebhookEvent[],
    payloadStyle: r.payload_style as 'event' | 'literal',
    literalBody: (r.literal_body as string | null) ?? null,
    includeBody: !!r.include_body,
    hasSecret: !!r.secret_encrypted,
    hasHeaders: !!r.headers_encrypted,
    lastStatus: (r.last_status as string | null) ?? null,
    lastAttemptAt: (r.last_attempt_at as Date | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
    consecutiveFailures: Number(r.consecutive_failures ?? 0),
    autoDisabledAt: (r.auto_disabled_at as Date | null) ?? null,
    createdAt: r.created_at as Date,
  }
}

function mapDelivery(r: Record<string, unknown>): WebhookDelivery {
  return {
    id: r.id as string,
    webhookId: r.webhook_id as string,
    event: r.event as WebhookEvent,
    messageId: (r.message_id as string | null) ?? null,
    threadId: (r.thread_id as string | null) ?? null,
    status: r.status as WebhookDelivery['status'],
    attempts: Number(r.attempts ?? 0),
    nextAttemptAt: r.next_attempt_at as Date,
    responseCode: r.response_code === null || r.response_code === undefined
      ? null
      : Number(r.response_code),
    error: (r.error as string | null) ?? null,
    payload: r.payload ?? null,
    createdAt: r.created_at as Date,
    deliveredAt: (r.delivered_at as Date | null) ?? null,
  }
}

/** Same shape as db.ts's optionalSecret: undefined leaves it alone, empty
 *  string clears it, anything else replaces it. Encrypting '' would store a
 *  perfectly valid encryption of nothing, which then reads back as "set". */
function optionalSecret(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  return encryptSecret(value)
}

export async function listWebhooks(): Promise<Webhook[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_webhooks" ORDER BY "created_at"
  `
  return rows.map(mapWebhook)
}

export async function getWebhook(id: string): Promise<Webhook | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_webhooks" WHERE "id" = ${id} LIMIT 1
  `
  return rows[0] ? mapWebhook(rows[0]) : null
}

/** The plaintext secret and headers, for the sender only. Never routed to a
 *  response: nothing that calls this returns its result to a browser. */
export async function getWebhookSecrets(id: string): Promise<WebhookSecrets> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "secret_encrypted", "headers_encrypted" FROM "uin_webhooks" WHERE "id" = ${id} LIMIT 1
  `
  const row = rows[0]
  if (!row) return { secret: null, headers: {} }

  const secret = tryDecryptSecret(row.secret_encrypted as string | null)
  const rawHeaders = tryDecryptSecret(row.headers_encrypted as string | null)

  let headers: Record<string, string> = {}
  if (rawHeaders) {
    try {
      const parsed: unknown = JSON.parse(rawHeaders)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        headers = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>)
            .filter(([, v]) => typeof v === 'string')
            .map(([k, v]) => [k, v as string]),
        )
      }
    } catch {
      // Stored headers that will not parse are treated as none at all. A
      // delivery going out without an API key gets a clean 401 from the far
      // end, which is a far better thing to read on the screen than a crash
      // during a mail sync.
      headers = {}
    }
  }

  return { secret, headers }
}

export async function createWebhook(data: WebhookInput): Promise<Webhook> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    INSERT INTO "uin_webhooks"
      ("name", "inbox_id", "url", "enabled", "events", "payload_style", "literal_body",
       "include_body", "secret_encrypted", "headers_encrypted")
    VALUES (${data.name}, ${data.inboxId ?? null}, ${data.url}, ${data.enabled ?? true},
            ${data.events}::text[], ${data.payloadStyle}, ${data.literalBody ?? null},
            ${data.includeBody ?? false},
            ${optionalSecret(data.secret) ?? null},
            ${data.headers === undefined ? null : optionalSecret(JSON.stringify(data.headers)) ?? null})
    RETURNING *
  `
  const row = rows[0]
  if (!row) throw new Error('The webhook could not be saved. Try again.')
  return mapWebhook(row)
}

export async function updateWebhook(id: string, data: WebhookPatch): Promise<Webhook | null> {
  const secret = optionalSecret(data.secret)
  const headers = data.headers === undefined
    ? undefined
    : optionalSecret(data.headers === null ? '' : JSON.stringify(data.headers))

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    UPDATE "uin_webhooks" SET
      "name"              = COALESCE(${data.name ?? null}, "name"),
      "inbox_id"          = CASE WHEN ${data.inboxId !== undefined} THEN ${data.inboxId ?? null} ELSE "inbox_id" END,
      "url"               = COALESCE(${data.url ?? null}, "url"),
      "enabled"           = COALESCE(${data.enabled ?? null}, "enabled"),
      "events"            = COALESCE(${data.events ?? null}::text[], "events"),
      "payload_style"     = COALESCE(${data.payloadStyle ?? null}, "payload_style"),
      "literal_body"      = CASE WHEN ${data.literalBody !== undefined} THEN ${data.literalBody ?? null} ELSE "literal_body" END,
      "include_body"      = COALESCE(${data.includeBody ?? null}, "include_body"),
      "secret_encrypted"  = CASE WHEN ${secret !== undefined} THEN ${secret ?? null} ELSE "secret_encrypted" END,
      "headers_encrypted" = CASE WHEN ${headers !== undefined} THEN ${headers ?? null} ELSE "headers_encrypted" END,
      -- Any edit is somebody saying "try it again": the failure count and the
      -- automatic switch-off both clear, or a fixed URL would stay dark.
      "consecutive_failures" = 0,
      "auto_disabled_at"     = NULL,
      "updated_at"           = CURRENT_TIMESTAMP
    WHERE "id" = ${id}
    RETURNING *
  `
  return rows[0] ? mapWebhook(rows[0]) : null
}

export async function deleteWebhook(id: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "uin_webhooks" WHERE "id" = ${id}`
}

/**
 * Queues one delivery per live subscription that cares about this inbox.
 *
 * The unique index on (webhook_id, event, message_id) is the real guard: two
 * ticks racing over the same message both land on ON CONFLICT DO NOTHING, so
 * an endpoint is told once about a message however many times it is re-read.
 */
export async function enqueueDeliveries(rows: {
  webhookId: string
  event: WebhookEvent
  messageId: string | null
  threadId: string | null
  payload: unknown
}[]): Promise<number> {
  let queued = 0
  for (const row of rows) {
    queued += await prisma.$executeRaw`
      INSERT INTO "uin_webhook_deliveries"
        ("webhook_id", "event", "message_id", "thread_id", "payload")
      VALUES (${row.webhookId}, ${row.event}, ${row.messageId}, ${row.threadId},
              ${JSON.stringify(row.payload)}::jsonb)
      ON CONFLICT ("webhook_id", "event", "message_id") WHERE "message_id" IS NOT NULL
        DO NOTHING
    `
  }
  return queued
}

/** Live subscriptions for an inbox, plus the ones watching every inbox. */
export async function webhooksForInbox(
  inboxId: string | null,
  event: WebhookEvent,
): Promise<Webhook[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_webhooks"
    WHERE "enabled" = true
      AND "auto_disabled_at" IS NULL
      AND ${event} = ANY("events")
      AND ("inbox_id" IS NULL OR "inbox_id" = ${inboxId})
    ORDER BY "created_at"
  `
  return rows.map(mapWebhook)
}

/**
 * Claims up to `limit` deliveries that are owed a go.
 *
 * The UPDATE is the claim: a row's next attempt is pushed out before anything
 * is sent, so a second tick starting while this one is still working never
 * picks up the same delivery and sends it twice.
 */
export async function claimDueDeliveries(limit: number): Promise<WebhookDelivery[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    UPDATE "uin_webhook_deliveries" SET
      "attempts"        = "attempts" + 1,
      "next_attempt_at" = CURRENT_TIMESTAMP + INTERVAL '10 minutes'
    WHERE "id" IN (
      SELECT "id" FROM "uin_webhook_deliveries"
      WHERE "status" IN ('pending', 'failed')
        AND "next_attempt_at" <= CURRENT_TIMESTAMP
      ORDER BY "next_attempt_at"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `
  return rows.map(mapDelivery)
}

export async function settleDelivery(
  id: string,
  outcome:
    | { ok: true; responseCode: number }
    | { ok: false; responseCode: number | null; error: string; retryInMinutes: number | null },
): Promise<void> {
  if (outcome.ok) {
    await prisma.$executeRaw`
      UPDATE "uin_webhook_deliveries" SET
        "status" = 'sent', "response_code" = ${outcome.responseCode},
        "error" = NULL, "delivered_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${id}
    `
    return
  }

  // No retry left means dead: the row stays for the screen to show, and
  // nothing picks it up again.
  const status = outcome.retryInMinutes === null ? 'dead' : 'failed'
  const minutes = outcome.retryInMinutes ?? 0
  await prisma.$executeRaw`
    UPDATE "uin_webhook_deliveries" SET
      "status" = ${status},
      "response_code" = ${outcome.responseCode},
      "error" = ${outcome.error.slice(0, 2000)},
      "next_attempt_at" = CURRENT_TIMESTAMP + (${minutes} * INTERVAL '1 minute')
    WHERE "id" = ${id}
  `
}

/** Records how a subscription is getting on, and switches it off by itself
 *  after a long enough run of failures. Nothing is retried for ever against an
 *  endpoint that has plainly gone away. */
export async function recordWebhookOutcome(
  webhookId: string,
  outcome: { ok: boolean; status: string; error: string | null; autoDisableAfter: number },
): Promise<void> {
  if (outcome.ok) {
    await prisma.$executeRaw`
      UPDATE "uin_webhooks" SET
        "last_status" = ${outcome.status}, "last_attempt_at" = CURRENT_TIMESTAMP,
        "last_error" = NULL, "consecutive_failures" = 0
      WHERE "id" = ${webhookId}
    `
    return
  }

  await prisma.$executeRaw`
    UPDATE "uin_webhooks" SET
      "last_status" = ${outcome.status},
      "last_attempt_at" = CURRENT_TIMESTAMP,
      "last_error" = ${(outcome.error ?? '').slice(0, 2000)},
      "consecutive_failures" = "consecutive_failures" + 1,
      "auto_disabled_at" = CASE
        WHEN "consecutive_failures" + 1 >= ${outcome.autoDisableAfter} THEN CURRENT_TIMESTAMP
        ELSE "auto_disabled_at"
      END
    WHERE "id" = ${webhookId}
  `
}

export async function recentDeliveries(webhookId: string, limit = 20): Promise<WebhookDelivery[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "uin_webhook_deliveries"
    WHERE "webhook_id" = ${webhookId}
    ORDER BY "created_at" DESC
    LIMIT ${limit}
  `
  return rows.map(mapDelivery)
}

/** The nightly tidy-up. Settled attempts are a log, and a log that grows for
 *  ever is a table nobody meant to create. */
export async function pruneDeliveries(olderThanDays: number): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM "uin_webhook_deliveries"
    WHERE "status" IN ('sent', 'dead')
      AND "created_at" < CURRENT_TIMESTAMP - (${olderThanDays} * INTERVAL '1 day')
  `
}
