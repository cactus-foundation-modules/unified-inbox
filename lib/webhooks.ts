import crypto from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { prisma } from '@/lib/db/prisma'
import {
  claimDueDeliveries,
  enqueueDeliveries,
  getWebhookSecrets,
  recordWebhookOutcome,
  settleDelivery,
  webhooksForInbox,
} from './webhooks-db'
import type { MessageReceivedPayload, Webhook, WebhookEvent } from './webhook-types'

// ---------------------------------------------------------------------------
// Telling something else when the post arrives.
//
// Two halves that never touch each other. Ingest QUEUES: a row per interested
// subscription, written in the same tick that filed the message, costing one
// insert. The scheduled tick SENDS: it picks up what is owed a go, tries it,
// and writes down what happened.
//
// They are kept apart on purpose. Mail collection runs inside a 25 second cron
// slice, and an endpoint that hangs for thirty seconds must not be able to cost
// a site its mail sync. The furthest a stalled webhook can set anything back
// is the sending half of one tick.
// ---------------------------------------------------------------------------

/** How long one delivery may take before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 10_000

/** The sending half's slice of a tick. Small deliberately: mail first. */
export const WEBHOOK_BUDGET_MS = 8_000

/** How many are claimed per tick at most. */
const BATCH = 20

/** Minutes to wait before attempt n+1. Running off the end means dead. */
const BACKOFF_MINUTES = [1, 5, 15, 60, 180, 720]

/** Consecutive failures before a subscription switches itself off. */
const AUTO_DISABLE_AFTER = 20

/** Bodies are capped so a mail with a novel attached to it cannot become a
 *  megabyte of JSON pushed at somebody's laptop. */
const MAX_BODY_CHARS = 20_000

// ---------------------------------------------------------------------------
// Where a delivery may be sent
// ---------------------------------------------------------------------------

/**
 * Refuses anything that is not a public HTTPS endpoint.
 *
 * This matters more than it looks. A webhook URL is typed into an admin screen
 * and then fetched by the server, which is the classic way to talk a site into
 * making requests on your behalf - at its own database, at another service on
 * the same private network, or at a cloud provider's metadata endpoint, which
 * hands out credentials to anything that asks from inside.
 *
 * So: HTTPS only, and the hostname must resolve to an address on the public
 * internet. Checked when the subscription is saved, and again immediately
 * before each send, because a name that resolved publicly on Tuesday can be
 * pointed at 127.0.0.1 on Wednesday.
 */
export async function checkDestination(url: string): Promise<{ ok: true } | { ok: false; why: string }> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, why: 'That does not look like a web address.' }
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, why: 'The address has to start with https. Anything sent over plain http can be read on the way.' }
  }

  let addresses: { address: string }[]
  try {
    addresses = await lookup(parsed.hostname, { all: true })
  } catch {
    return { ok: false, why: 'That address does not seem to exist - nothing answers to that name.' }
  }
  if (addresses.length === 0) {
    return { ok: false, why: 'That address does not seem to exist - nothing answers to that name.' }
  }

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      return {
        ok: false,
        why: 'That address points at something on this server or its own network, which is not somewhere a webhook may send.',
      }
    }
  }

  return { ok: true }
}

/** Loopback, private, link-local, carrier-grade NAT and the rest - the ranges
 *  that are never a legitimate destination for an outbound webhook. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase()

  if (ip.includes(':')) {
    // IPv6. ::1 loopback, :: unspecified, fc00::/7 unique-local, fe80::/10
    // link-local, and anything wrapping an IPv4 address gets unwrapped first.
    if (ip === '::1' || ip === '::') return true
    if (/^f[cd]/.test(ip)) return true
    if (/^fe[89ab]/.test(ip)) return true
    const mapped = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped?.[1]) return isPrivateAddress(mapped[1])
    return false
  }

  const parts = ip.split('.').map((p) => Number(p))
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true
  const a = parts[0] as number
  const b = parts[1] as number

  if (a === 0) return true                        // this network
  if (a === 10) return true                       // private
  if (a === 127) return true                      // loopback
  if (a === 169 && b === 254) return true         // link-local, and cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 168) return true         // private
  if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT
  if (a === 192 && b === 0) return true           // IETF protocol assignments
  if (a >= 224) return true                       // multicast and reserved
  return false
}

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

/**
 * Called once for each message that has just been filed, by both ingest paths.
 *
 * Deliberately swallows its own errors. A webhook is a courtesy to something
 * outside; a message that has been collected and stored must never be lost, or
 * a sync run aborted, because of one. The worst case here is that an endpoint
 * is not told, which the settings screen then shows.
 */
export async function queueMessageWebhooks(messageId: string): Promise<number> {
  try {
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT
        m."id"              AS message_id,
        m."thread_id"       AS thread_id,
        m."direction"       AS direction,
        m."channel"         AS channel,
        m."from_name"       AS from_name,
        m."from_address"    AS from_address,
        m."from_phone"      AS from_phone,
        m."subject"         AS subject,
        m."snippet"         AS snippet,
        m."body_text"       AS body_text,
        m."sent_at"         AS sent_at,
        m."has_attachments" AS has_attachments,
        t."subject"         AS thread_subject,
        t."inbox_id"        AS inbox_id,
        i."name"            AS inbox_name,
        i."address"         AS inbox_address
      FROM "uin_messages" m
      JOIN "uin_threads" t ON t."id" = m."thread_id"
      LEFT JOIN "uin_inboxes" i ON i."id" = t."inbox_id"
      WHERE m."id" = ${messageId}
      LIMIT 1
    `
    const row = rows[0]
    if (!row) return 0

    // Only what arrived. A reply somebody typed in the admin, and an internal
    // note, are this site talking to itself - firing "a message came in" for
    // them would have an automation answering its own post.
    if (row.direction !== 'in') return 0

    const inboxId = (row.inbox_id as string | null) ?? null
    const hooks = await webhooksForInbox(inboxId, 'message.received')
    if (hooks.length === 0) return 0

    return await enqueueDeliveries(hooks.map((hook) => ({
      webhookId: hook.id,
      event: 'message.received' as WebhookEvent,
      messageId: row.message_id as string,
      threadId: row.thread_id as string,
      payload: hook.payloadStyle === 'literal'
        ? { style: 'literal' as const }
        : { style: 'event' as const, body: buildMessagePayload(row, hook) },
    })))
  } catch (error) {
    console.error('[unified-inbox] could not queue webhooks for a message', error)
    return 0
  }
}

function buildMessagePayload(row: Record<string, unknown>, hook: Webhook): MessageReceivedPayload {
  const threadId = row.thread_id as string
  const site = process.env.SITE_URL ?? ''

  const payload: MessageReceivedPayload = {
    event: 'message.received',
    at: new Date().toISOString(),
    site,
    inbox: {
      id: (row.inbox_id as string | null) ?? null,
      name: (row.inbox_name as string | null) ?? null,
      address: (row.inbox_address as string | null) ?? null,
    },
    conversation: {
      id: threadId,
      subject: (row.thread_subject as string | null) ?? null,
      url: site ? `${site.replace(/\/$/, '')}/cactus-admin/inbox?thread=${threadId}` : null,
    },
    message: {
      id: row.message_id as string,
      channel: (row.channel as string | null) ?? 'email',
      direction: row.direction as 'in' | 'out' | 'note',
      from: {
        name: (row.from_name as string | null) ?? null,
        address: (row.from_address as string | null) ?? null,
        phone: (row.from_phone as string | null) ?? null,
      },
      subject: (row.subject as string | null) ?? null,
      snippet: (row.snippet as string | null) ?? null,
      sentAt: (row.sent_at as Date).toISOString(),
      hasAttachments: !!row.has_attachments,
    },
  }

  if (hook.includeBody) {
    const body = (row.body_text as string | null) ?? null
    payload.message.bodyText = body ? body.slice(0, MAX_BODY_CHARS) : null
  }

  return payload
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * The signature the far end checks.
 *
 * Over timestamp, nonce, method, path and the exact bytes of the body. The
 * nonce is not decoration: without it two identical deliveries in the same
 * second sign identically, and a receiver that refuses a repeated signature -
 * which is the whole point of keeping one - would refuse the second as a
 * replay of the first.
 */
export function signBody(secret: string, path: string, body: string): {
  timestamp: string
  nonce: string
  signature: string
} {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = crypto.randomBytes(16).toString('hex')
  const payload = `${timestamp}.${nonce}.POST.${path}.${body}`
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex')
  return { timestamp, nonce, signature }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type SendResult =
  | { ok: true; status: number }
  | { ok: false; status: number | null; error: string }

/** One request. Shared by the scheduled sender and the Send a test button, so
 *  what the test proves is exactly what the real thing does. */
export async function deliverOnce(
  webhook: Webhook,
  body: string,
): Promise<SendResult> {
  const destination = await checkDestination(webhook.url)
  if (!destination.ok) return { ok: false, status: null, error: destination.why }

  const { secret, headers: extra } = await getWebhookSecrets(webhook.id)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // Named rather than left to the runtime's default: a bare library user
    // agent is what bot rules block, and the resulting refusal looks nothing
    // like the configuration mistake it is not.
    'User-Agent': 'cactus-unified-inbox/1.0',
    ...extra,
  }

  if (secret) {
    const path = new URL(webhook.url).pathname
    const signed = signBody(secret, path, body)
    headers['X-Cactus-Timestamp'] = signed.timestamp
    headers['X-Cactus-Nonce'] = signed.nonce
    headers['X-Cactus-Signature'] = `sha256=${signed.signature}`
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(webhook.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
      redirect: 'error',
    })
    if (res.ok) return { ok: true, status: res.status }

    // A little of what came back, because "403" on its own tells the owner
    // nothing and the far end usually says why.
    const text = await res.text().catch(() => '')
    return { ok: false, status: res.status, error: text.slice(0, 500) || `The endpoint answered ${res.status}.` }
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError'
      ? 'The endpoint did not answer in time.'
      : error instanceof Error ? error.message : 'The request failed.'
    return { ok: false, status: null, error: message }
  } finally {
    clearTimeout(timer)
  }
}

/** The body that actually goes over the wire. A literal subscription sends what
 *  was typed into it, verbatim and every time - that is what an endpoint with
 *  its own request shape needs. */
export function bodyFor(webhook: Webhook, queued: unknown): string {
  if (webhook.payloadStyle === 'literal') return webhook.literalBody ?? '{}'
  const payload = (queued as { body?: unknown } | null)?.body
  return JSON.stringify(payload ?? {})
}

/**
 * The sending half, called from the scheduled tick.
 *
 * Claims a batch, sends what it can inside its slice, and leaves the rest for
 * the next tick. Returns counts for the tick's own log.
 */
export async function deliverPending(options: { deadline: number }): Promise<{
  sent: number
  failed: number
}> {
  let sent = 0
  let failed = 0

  const due = await claimDueDeliveries(BATCH)
  for (const delivery of due) {
    if (Date.now() > options.deadline) break

    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM "uin_webhooks" WHERE "id" = ${delivery.webhookId} LIMIT 1
    `
    const row = rows[0]
    if (!row) continue

    const webhook: Webhook = {
      id: row.id as string,
      name: row.name as string,
      inboxId: (row.inbox_id as string | null) ?? null,
      url: row.url as string,
      enabled: !!row.enabled,
      events: ((row.events as string[] | null) ?? []) as WebhookEvent[],
      payloadStyle: row.payload_style as 'event' | 'literal',
      literalBody: (row.literal_body as string | null) ?? null,
      includeBody: !!row.include_body,
      hasSecret: !!row.secret_encrypted,
      hasHeaders: !!row.headers_encrypted,
      lastStatus: null,
      lastAttemptAt: null,
      lastError: null,
      consecutiveFailures: Number(row.consecutive_failures ?? 0),
      autoDisabledAt: (row.auto_disabled_at as Date | null) ?? null,
      createdAt: row.created_at as Date,
    }

    const result = await deliverOnce(webhook, bodyFor(webhook, delivery.payload))

    if (result.ok) {
      sent += 1
      await settleDelivery(delivery.id, { ok: true, responseCode: result.status })
      await recordWebhookOutcome(webhook.id, {
        ok: true,
        status: String(result.status),
        error: null,
        autoDisableAfter: AUTO_DISABLE_AFTER,
      })
      continue
    }

    failed += 1
    // The claim already counted this go, so one attempt made means attempts is
    // 1 and the wait before the next is the first entry, not the second.
    const waited = delivery.attempts - 1
    const retryInMinutes = BACKOFF_MINUTES[waited] ?? null
    await settleDelivery(delivery.id, {
      ok: false,
      responseCode: result.status,
      error: result.error,
      retryInMinutes,
    })
    await recordWebhookOutcome(webhook.id, {
      ok: false,
      status: result.status === null ? 'no answer' : String(result.status),
      error: result.error,
      autoDisableAfter: AUTO_DISABLE_AFTER,
    })
  }

  return { sent, failed }
}
