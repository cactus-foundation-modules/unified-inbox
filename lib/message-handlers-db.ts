import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { MAX_SCAN_CHARS } from './linking'
import type { HandlerNote, InboundMessageEvent } from './types'

// ---------------------------------------------------------------------------
// The SQL behind `unified-inbox.message-received` (lib/message-handlers.ts).
//
// Its own file rather than more of lib/db.ts: every query here is about one
// question - which messages are offered to other modules, and what came back -
// and the live test for them (message-handlers.live.test.ts) exercises exactly
// this file against a real database.
// ---------------------------------------------------------------------------

/** How far back the hourly catch-up looks for a message that was never
 *  offered. Long enough to cover a weekend of failed deploys, short enough that
 *  a module installed today is not handed a year of post. */
export const CATCH_UP_DAYS = 3

/** How far back the "offer the last 14 days again" button reaches. */
export const REOFFER_DAYS = 14

/** How long a claim holds before it is taken to belong to a run that died.
 *  Far longer than any one offer can take inside a 60 second function. */
const CLAIM_MINUTES = 2

/** Messages this young are left to the collecting pass that filed them, which
 *  is offering them now; the catch-up would only be racing it. */
const SETTLING_MINUTES = 5

/**
 * The one rule for which messages are offered at all, written once so the
 * inline offer, the catch-up and the button cannot drift apart.
 *
 * Inbound only - never our own writing, never a colleague's note. Never mail
 * the system wrote (auto_kind: a bounce, an out-of-office, a newsletter), which
 * is not paperwork. Never post the site refused (blocked_at), and never a
 * conversation anybody here has marked as junk.
 *
 * Expects the message as `m` and its conversation as `t`.
 */
const OFFERABLE = Prisma.sql`
      m."direction" = 'in'
  AND m."auto_kind" IS NULL
  AND t."blocked_at" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "uin_thread_spam" s WHERE s."thread_id" = m."thread_id")
`

export type OfferableMessage = {
  event: InboundMessageEvent
  handledAt: Date | null
  notes: HandlerNote[]
}

/**
 * One message in the shape handlers are given, or null when it is not one they
 * are ever offered (see OFFERABLE) or has gone.
 */
export async function loadOfferableMessage(messageId: string): Promise<OfferableMessage | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT m."id", m."thread_id", m."from_address", m."to_addresses", m."cc_addresses", m."subject",
           LEFT(COALESCE(m."body_text", ''), ${MAX_SCAN_CHARS}::int) AS "body_text",
           m."sent_at", m."handled_at", m."handler_notes"
      FROM "uin_messages" m
      JOIN "uin_threads" t ON t."id" = m."thread_id"
     WHERE m."id" = ${messageId}
       AND ${OFFERABLE}
  `
  const r = rows[0]
  if (!r) return null

  const files = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "id", "filename", "content_type", "size_bytes", "media_id", "content_id"
      FROM "uin_attachments"
     WHERE "message_id" = ${messageId}
     ORDER BY "created_at" ASC, "id" ASC
  `

  return {
    event: {
      messageId: r.id as string,
      threadId: r.thread_id as string,
      fromAddress: ((r.from_address as string | null) ?? '').toLowerCase(),
      toAddresses: (r.to_addresses as string[] | null) ?? [],
      ccAddresses: (r.cc_addresses as string[] | null) ?? [],
      subject: (r.subject as string | null) ?? '',
      bodyText: r.body_text as string,
      sentAt: (r.sent_at as Date).toISOString(),
      attachments: files.map((f) => ({
        attachmentId: f.id as string,
        filename: f.filename as string,
        mimeType: (f.content_type as string | null) ?? 'application/octet-stream',
        sizeBytes: Number(f.size_bytes ?? 0),
        // An inline part is a signature logo or a pasted screenshot, whatever
        // row it has. Listeners are told to ignore it by its null.
        mediaId: f.content_id ? null : ((f.media_id as string | null) ?? null),
      })),
    },
    handledAt: (r.handled_at as Date | null) ?? null,
    notes: readNotes(r.handler_notes),
  }
}

/** What handler_notes holds, trusted no further than its shape. */
export function readNotes(value: unknown): HandlerNote[] {
  if (!Array.isArray(value)) return []
  return value.filter((n): n is HandlerNote =>
    !!n && typeof n === 'object'
    && typeof (n as HandlerNote).source === 'string'
    && typeof (n as HandlerNote).moduleName === 'string'
    && typeof (n as HandlerNote).note === 'string'
    && typeof (n as HandlerNote).at === 'string')
}

/**
 * Take the claim on a message before its listeners run, or learn that somebody
 * else holds it. One UPDATE, so two callers racing for the same message cannot
 * both win: the collecting pass and the hourly catch-up, or the button and
 * either of them.
 *
 * Without `force`, a message already offered is not claimed at all. With it -
 * the button - it is, but never out from under a run still in progress.
 */
export async function claimOffer(messageId: string, force: boolean): Promise<boolean> {
  const unoffered = force ? Prisma.empty : Prisma.sql`AND "handled_at" IS NULL`
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "uin_messages"
       SET "offering_at" = now(), "offer_attempts" = "offer_attempts" + 1
     WHERE "id" = ${messageId}
       ${unoffered}
       AND ("offering_at" IS NULL
            OR "offering_at" < now() - make_interval(mins => ${CLAIM_MINUTES}::int))
    RETURNING "id"
  `
  return rows.length > 0
}

/**
 * Let go of a claim without recording anything - a run that could not start.
 *
 * `refund` takes back the attempt the claim counted, for a run handed back
 * only because there was no time left: that is the clock, not the message,
 * and counting it would sink the message behind others for no fault of its
 * own.
 */
export async function releaseClaim(messageId: string, opts: { refund?: boolean } = {}): Promise<void> {
  const refund = opts.refund
    ? Prisma.sql`, "offer_attempts" = GREATEST("offer_attempts" - 1, 0)`
    : Prisma.empty
  await prisma.$executeRaw`
    UPDATE "uin_messages" SET "offering_at" = NULL ${refund} WHERE "id" = ${messageId}
  `
}

/**
 * Write what the handlers said back, let go of the claim, and - when every
 * handler had its turn - record that the message has been offered.
 *
 * The notes are written whole: the caller has already folded this run's lines
 * into the ones a previous offer left.
 */
export async function recordOffer(
  messageId: string,
  data: { notes: HandlerNote[]; stamp: boolean },
): Promise<void> {
  const notes = data.notes.length > 0
    ? Prisma.sql`${JSON.stringify(data.notes)}::jsonb`
    : Prisma.sql`NULL`
  const stamp = data.stamp ? Prisma.sql`, "handled_at" = now()` : Prisma.empty
  await prisma.$executeRaw`
    UPDATE "uin_messages"
       SET "handler_notes" = ${notes}, "offering_at" = NULL ${stamp}
     WHERE "id" = ${messageId}
  `
}

/**
 * Messages collected in the last few days that were never offered: a run that
 * ran out of time, a deploy mid-flight, a module installed after the post came.
 *
 * Both dates on purpose. created_at is when this site filed it, which is what
 * "in the last three days" means; sent_at keeps out the history a new mail
 * account is read in with - a year of old post filed this morning is not news
 * to anybody.
 *
 * Never the last few minutes (the collecting pass that filed it is offering it
 * now) and never one somebody holds the claim on. Fewest attempts first, then
 * oldest: a message that keeps failing sinks behind the ones that have not been
 * tried, rather than heading the queue every hour for three days.
 *
 * Served by uin_messages_unhandled_idx (migration 070).
 */
export async function unofferedMessageIds(limit: number): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT m."id"
      FROM "uin_messages" m
      JOIN "uin_threads" t ON t."id" = m."thread_id"
     WHERE m."handled_at" IS NULL
       AND m."created_at" >= now() - make_interval(days => ${CATCH_UP_DAYS}::int)
       AND m."created_at" < now() - make_interval(mins => ${SETTLING_MINUTES}::int)
       AND m."sent_at" >= now() - make_interval(days => ${CATCH_UP_DAYS}::int)
       AND (m."offering_at" IS NULL
            OR m."offering_at" < now() - make_interval(mins => ${CLAIM_MINUTES}::int))
       AND ${OFFERABLE}
     ORDER BY m."offer_attempts" ASC, m."created_at" ASC, m."id" ASC
     LIMIT ${limit}
  `
  return rows.map((r) => r.id)
}

/**
 * Stamp as settled the unoffered rows the catch-up will never offer, so they
 * leave uin_messages_unhandled_idx instead of sitting in it for ever: anything
 * collected before the window (including everything already here on the day
 * something first listened), history read in with a new account, and post
 * from a blocked sender or on a junked conversation. The button still reaches
 * all of it - it ignores the stamp.
 *
 * In bounded batches, oldest first, through the index. Only ever run by the
 * catch-up, which only runs when something listens: a site with no listeners
 * has nothing stamped, ever.
 */
export async function settleUnofferable(limit: number): Promise<number> {
  return prisma.$executeRaw`
    UPDATE "uin_messages" u
       SET "handled_at" = now()
     WHERE u."id" IN (
            SELECT m."id"
              FROM "uin_messages" m
              JOIN "uin_threads" t ON t."id" = m."thread_id"
             WHERE m."handled_at" IS NULL
               AND m."direction" = 'in'
               AND m."auto_kind" IS NULL
               AND m."created_at" < now() - make_interval(mins => ${SETTLING_MINUTES}::int)
               AND (m."created_at" < now() - make_interval(days => ${CATCH_UP_DAYS}::int)
                    OR m."sent_at" < now() - make_interval(days => ${CATCH_UP_DAYS}::int)
                    OR t."blocked_at" IS NOT NULL
                    OR EXISTS (SELECT 1 FROM "uin_thread_spam" s WHERE s."thread_id" = m."thread_id"))
             ORDER BY m."created_at" ASC
             LIMIT ${limit}
           )
  `
}

/**
 * One page of an inbox's post from the last fortnight, whether or not it was
 * offered before, for the "offer the last 14 days again" button.
 *
 * Paged by the last id handed out rather than by an offset, because offering a
 * message writes to it and the button's run is spread over several requests.
 * By the date on the message, which is what "the last 14 days" means to
 * somebody looking at their inbox.
 */
export async function inboxMessageIdsToReoffer(
  inboxId: string,
  afterId: string | null,
  limit: number,
): Promise<string[]> {
  const after = afterId
    ? Prisma.sql`AND (m."created_at", m."id") > (
        SELECT p."created_at", p."id" FROM "uin_messages" p WHERE p."id" = ${afterId}
      )`
    : Prisma.empty
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT m."id"
      FROM "uin_messages" m
      JOIN "uin_threads" t ON t."id" = m."thread_id"
     WHERE (t."inbox_id" = ${inboxId} OR m."inbox_id" = ${inboxId})
       AND m."sent_at" >= now() - make_interval(days => ${REOFFER_DAYS}::int)
       AND ${OFFERABLE}
       ${after}
     ORDER BY m."created_at" ASC, m."id" ASC
     LIMIT ${limit}
  `
  return rows.map((r) => r.id)
}

export type UnstoredAttachment = { id: string; contentType: string | null; sizeBytes: number | null }

/**
 * A message's files that are not in the media library and could be fetched
 * from the mail server - collected before anything was listening. Inline parts
 * are left out, as ever. What the caller may actually fetch and store is
 * decided in lib/inbound-file-policy.ts, not here.
 */
export async function unstoredAttachments(messageId: string): Promise<UnstoredAttachment[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "id", "content_type", "size_bytes" FROM "uin_attachments"
     WHERE "message_id" = ${messageId}
       AND "media_id" IS NULL
       AND "content_id" IS NULL
       AND "imap_part_id" IS NOT NULL
     ORDER BY "created_at" ASC, "id" ASC
  `
  return rows.map((r) => ({
    id: r.id as string,
    contentType: (r.content_type as string | null) ?? null,
    sizeBytes: r.size_bytes === null || r.size_bytes === undefined ? null : Number(r.size_bytes),
  }))
}

/** Bytes already in the library for a message, counted against its allowance. */
export async function storedAttachmentBytes(messageId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ total: bigint | number | null }[]>`
    SELECT COALESCE(SUM("size_bytes"), 0) AS "total" FROM "uin_attachments"
     WHERE "message_id" = ${messageId} AND "media_id" IS NOT NULL AND "content_id" IS NULL
  `
  return Number(rows[0]?.total ?? 0)
}

/**
 * A listener's link, unless somebody took that very link off this
 * conversation before (uin_record_link_removals). Automatic, like a pattern
 * link; a link already there is left as it is.
 */
export async function recordHandlerLink(data: {
  threadId: string
  moduleName: string
  recordType: string
  recordId: string
  label: string
  confidence: number
}): Promise<boolean> {
  const inserted = await prisma.$executeRaw`
    INSERT INTO "uin_record_links"
      ("thread_id", "person_id", "module_name", "record_type", "record_id",
       "label", "confidence", "linked_by")
    SELECT ${data.threadId}, NULL, ${data.moduleName}, ${data.recordType},
           ${data.recordId}, ${data.label}, ${data.confidence}, 'auto'
     WHERE NOT EXISTS (
           SELECT 1 FROM "uin_record_link_removals" r
            WHERE r."thread_id" = ${data.threadId} AND r."module_name" = ${data.moduleName}
              AND r."record_type" = ${data.recordType} AND r."record_id" = ${data.recordId})
    ON CONFLICT DO NOTHING
  `
  return inserted > 0
}

/** Note that somebody took an automatic link off a conversation. */
export async function rememberRemovedAutoLink(data: {
  threadId: string
  moduleName: string
  recordType: string
  recordId: string
  removedBy: string | null
}): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "uin_record_link_removals"
      ("thread_id", "module_name", "record_type", "record_id", "removed_by")
    VALUES (${data.threadId}, ${data.moduleName}, ${data.recordType}, ${data.recordId}, ${data.removedBy})
    ON CONFLICT ("thread_id", "module_name", "record_type", "record_id")
    DO UPDATE SET "removed_at" = CURRENT_TIMESTAMP, "removed_by" = EXCLUDED."removed_by"
  `
}
