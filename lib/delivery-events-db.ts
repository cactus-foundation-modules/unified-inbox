import { prisma } from '@/lib/db/prisma'

// ---------------------------------------------------------------------------
// Filing what became of a sent message: the ledger in uin_delivery_events and
// the summary columns on the message it is about.
//
// In a file of its own, importing nothing but the database client, because it
// is reached from somewhere unusually hot and public: core's open-picture and
// link-redirect routes hand every event to this module's listener (see
// own-tracking.ts), and those run each time a customer opens an email. db.ts
// brings the HTML sanitiser and everything behind it; this brings nothing.
// db.ts re-exports all of it, so every existing caller is unchanged.
// ---------------------------------------------------------------------------

/** One thing that happened to a sent message. `receipt_unread` is a read
 *  receipt saying the message was deleted without being opened, which is worth
 *  recording and is emphatically not an open. `clicked` carries the address
 *  that was followed in `detail`, and is the one kind where two events in the
 *  same second are two events (M047). */
export type DeliveryUpdate = {
  kind: 'delivered' | 'opened' | 'proxy_open' | 'clicked' | 'bounced' | 'receipt' | 'receipt_unread'
  occurredAt: Date
  detail: string | null
  bounceKind: string | null
  /** 'brevo' for the mail service's own events, 'receipt' for a read receipt,
   *  'site' for what the site's own tracking saw (M061). */
  source: 'brevo' | 'receipt' | 'site'
  /** The address the event came from and the program that made it, where
   *  whoever reported it said. Neither is needed to file the event; both are
   *  what the history screen shows when somebody asks who fetched it. */
  ip?: string | null
  userAgent?: string | null
}

/**
 * Our sent messages one of core's own tracking events is about (M061).
 *
 * Two ways home, and a message may answer to either. A reply written here
 * carries its own row id in the signed token (`ref`), which is exact and needs
 * nothing else. A copy of another module's mail - an order confirmation kept
 * on a conversation - was filed after it had gone, so the only handle is the
 * EmailLog row core wrote, which the copy stores. Everything sent here since
 * 061 stores that too, so the second way also catches a reply whose token was
 * minted before the ref was carried.
 *
 * Scoped to sent mail, for the same reason the provider lookup above is: our
 * own copy landing back in a Sent folder must never be the row that answers.
 */
export async function outboundIdsForTrackingEvent(input: {
  ref: string | null
  emailLogId: string
}): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id"
      FROM "uin_messages"
     WHERE "direction" = 'out'
       AND ("email_log_id" = ${input.emailLogId}
            OR (${input.ref}::text IS NOT NULL AND "id" = ${input.ref}::text))
     ORDER BY "created_at" ASC
     LIMIT 5
  `
  return [...new Set(rows.map((row) => row.id))]
}

/**
 * Files one delivery event against one of our sent messages.
 *
 * Returns false when there was nothing to file: a message that no longer exists
 * because the retention sweep has been through, one that was never ours, or an
 * occurrence already recorded. None of those is an error - two of them are the
 * system working - so the caller answers the sender cheerfully either way and
 * nothing gets retried for ever.
 */
export async function recordDeliveryEvent(
  messageId: string,
  update: DeliveryUpdate,
): Promise<boolean> {
  const owned = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "uin_messages"
     WHERE "id" = ${messageId} AND "direction" = 'out'
     LIMIT 1
  `
  if (!owned[0]) return false

  // Two unique indexes, so two conflict targets - and each has to name the
  // index's own WHERE clause, because Postgres will not infer a partial index
  // without it. A click deduplicates on the address as well as the moment: a
  // scanner working through every link in a message does them all inside one
  // second, and those are five clicks rather than one (M047).
  const detail = update.detail === null ? null : update.detail.slice(0, 2000)
  const ip = update.ip ? update.ip.slice(0, 64) : null
  const userAgent = update.userAgent ? update.userAgent.slice(0, 500) : null
  const inserted = update.kind === 'clicked'
    ? await prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO "uin_delivery_events" ("message_id", "kind", "source", "detail", "occurred_at", "ip", "user_agent")
        VALUES (${messageId}, ${update.kind}, ${update.source}, ${detail}, ${update.occurredAt}, ${ip}, ${userAgent})
        ON CONFLICT ("message_id", "occurred_at", COALESCE("detail", ''))
          WHERE "kind" = 'clicked'
          DO NOTHING
        RETURNING "id"
      `
    : await prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO "uin_delivery_events" ("message_id", "kind", "source", "detail", "occurred_at", "ip", "user_agent")
        VALUES (${messageId}, ${update.kind}, ${update.source}, ${detail}, ${update.occurredAt}, ${ip}, ${userAgent})
        ON CONFLICT ("message_id", "kind", "occurred_at")
          WHERE "kind" <> 'clicked'
          DO NOTHING
        RETURNING "id"
      `
  // Already had it. The counters must not move, which is the entire reason the
  // insert happens before the update rather than beside it.
  if (!inserted[0]) return false

  await applyDeliveryEvent(messageId, update)
  return true
}

/** The summary columns on the message, brought up to date by one new event. */
async function applyDeliveryEvent(messageId: string, update: DeliveryUpdate): Promise<void> {
  if (update.kind === 'delivered') {
    // A soft bounce or a deferral that was followed by a delivery was the mail
    // service retrying and getting there. Leaving the failure showing would
    // have somebody chasing a message that arrived.
    await prisma.$executeRaw`
      UPDATE "uin_messages"
         SET "delivered_at" = COALESCE("delivered_at", ${update.occurredAt}),
             "bounced_at"    = CASE WHEN "bounce_kind" IN ('soft', 'deferred') THEN NULL ELSE "bounced_at" END,
             "bounce_kind"   = CASE WHEN "bounce_kind" IN ('soft', 'deferred') THEN NULL ELSE "bounce_kind" END,
             "bounce_detail" = CASE WHEN "bounce_kind" IN ('soft', 'deferred') THEN NULL ELSE "bounce_detail" END
       WHERE "id" = ${messageId}
    `
    return
  }

  if (update.kind === 'opened' || update.kind === 'receipt') {
    // A receipt beats a pixel: somebody's mail program was asked and answered.
    const strength = update.kind === 'receipt' ? 'receipt' : 'human'
    await prisma.$executeRaw`
      UPDATE "uin_messages"
         SET "opened_at"    = COALESCE("opened_at", ${update.occurredAt}),
             "last_open_at" = GREATEST(COALESCE("last_open_at", ${update.occurredAt}), ${update.occurredAt}),
             "open_count"   = "open_count" + 1,
             "open_source"  = CASE
                                WHEN "open_source" = 'receipt' THEN "open_source"
                                ELSE ${strength}
                              END,
             "delivered_at" = COALESCE("delivered_at", ${update.occurredAt})
       WHERE "id" = ${messageId}
    `
    return
  }

  if (update.kind === 'proxy_open') {
    // Deliberately does NOT set opened_at or move the counter. A mail app
    // fetched the picture; that is all anybody knows, and the screen says so in
    // those words rather than claiming somebody read it.
    await prisma.$executeRaw`
      UPDATE "uin_messages"
         SET "last_open_at" = GREATEST(COALESCE("last_open_at", ${update.occurredAt}), ${update.occurredAt}),
             "open_source"  = COALESCE("open_source", 'proxy'),
             "delivered_at" = COALESCE("delivered_at", ${update.occurredAt})
       WHERE "id" = ${messageId}
    `
    return
  }

  if (update.kind === 'clicked') {
    // Deliberately does NOT touch the open columns, for the same reason a proxy
    // open does not: a click can be a mail scanner checking where a link goes,
    // and "they opened it" is a sentence somebody rings a customer on the
    // strength of. It does imply delivery, though - nothing gets followed out
    // of a message that never landed.
    await prisma.$executeRaw`
      UPDATE "uin_messages"
         SET "clicked_at"    = COALESCE("clicked_at", ${update.occurredAt}),
             "last_click_at" = GREATEST(COALESCE("last_click_at", ${update.occurredAt}), ${update.occurredAt}),
             "click_count"   = "click_count" + 1,
             "delivered_at"  = COALESCE("delivered_at", ${update.occurredAt})
       WHERE "id" = ${messageId}
    `
    return
  }

  if (update.kind === 'bounced') {
    await prisma.$executeRaw`
      UPDATE "uin_messages"
         SET "bounced_at"    = ${update.occurredAt},
             "bounce_kind"   = ${update.bounceKind},
             "bounce_detail" = ${update.detail === null ? null : update.detail.slice(0, 2000)}
       WHERE "id" = ${messageId}
    `
    return
  }

  // receipt_unread. The event row is the whole point of it - nothing on the
  // message changes, because nothing about the message did.
}
