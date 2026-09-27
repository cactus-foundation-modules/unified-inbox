import { prisma } from '@/lib/db/prisma'
import { encryptSecret, tryDecryptSecret } from '@/lib/crypto/secrets'
import { generateVapidKeys, isVapidKeys, type PushSubscriptionKeys, type VapidKeys } from './web-push'

// ---------------------------------------------------------------------------
// The tables behind browser push (migration 064): the site's signing pair, the
// browsers that have said yes, and the ledger that makes one message one nudge.
// See lib/push-nudges.ts for what is done with them.
// ---------------------------------------------------------------------------

/**
 * The site's VAPID pair, made the first time anybody asks.
 *
 * Two people turning nudges on at the same moment must end up with the SAME
 * pair, because each browser's subscription is bound to the public half it was
 * given: the insert keeps whichever pair got there first, and hands that back to
 * both of them.
 *
 * A stored pair that no longer decrypts - a backup restored onto a site with a
 * different ENCRYPTION_KEY - is replaced, and every subscription goes with it:
 * they were bound to a key this site can no longer sign with, so they are
 * already dead, and the browsers subscribe again the next time the hub is
 * opened (they compare keys - see NewMailNotifier).
 */
export async function getOrCreateVapidKeys(): Promise<VapidKeys> {
  const current = await readVapidKeys()
  if (current) return current

  const fresh = generateVapidKeys()
  const stored = await prisma.$queryRaw<{ push_vapid_public: string; push_vapid_private_encrypted: string }[]>`
    INSERT INTO "uin_settings" ("id", "push_vapid_public", "push_vapid_private_encrypted")
    VALUES ('singleton', ${fresh.publicKey}, ${encryptSecret(fresh.privateKey)})
    ON CONFLICT ("id") DO UPDATE SET
      "push_vapid_public" = CASE WHEN "uin_settings"."push_vapid_public" IS NULL
                                 THEN EXCLUDED."push_vapid_public" ELSE "uin_settings"."push_vapid_public" END,
      "push_vapid_private_encrypted" = CASE WHEN "uin_settings"."push_vapid_public" IS NULL
                                 THEN EXCLUDED."push_vapid_private_encrypted" ELSE "uin_settings"."push_vapid_private_encrypted" END
    RETURNING "push_vapid_public", "push_vapid_private_encrypted"
  `
  const row = stored[0]
  const kept = row ? decode(row.push_vapid_public, row.push_vapid_private_encrypted) : null
  if (kept) return kept

  // What is stored is unusable. Replace it outright, and let the browsers bound
  // to it go - see above.
  await prisma.$transaction([
    prisma.$executeRaw`
      UPDATE "uin_settings"
         SET "push_vapid_public" = ${fresh.publicKey},
             "push_vapid_private_encrypted" = ${encryptSecret(fresh.privateKey)}
       WHERE "id" = 'singleton'
    `,
    prisma.$executeRaw`DELETE FROM "uin_push_subscriptions"`,
  ])
  // Read back rather than trusted: two people arriving at once would each write
  // a pair, and only the one that stayed is worth handing to a browser.
  return (await readVapidKeys()) ?? fresh
}

/** The pair as stored, or null when there is none or it does not decrypt into
 *  a pair that belongs together. */
export async function readVapidKeys(): Promise<VapidKeys | null> {
  const rows = await prisma.$queryRaw<{ push_vapid_public: string | null; push_vapid_private_encrypted: string | null }[]>`
    SELECT "push_vapid_public", "push_vapid_private_encrypted" FROM "uin_settings" WHERE "id" = 'singleton'
  `
  const row = rows[0]
  return row ? decode(row.push_vapid_public, row.push_vapid_private_encrypted) : null
}

function decode(publicKey: string | null, privateEncrypted: string | null): VapidKeys | null {
  if (!publicKey || !privateEncrypted) return null
  const privateKey = tryDecryptSecret(privateEncrypted)
  if (!privateKey) return null
  const keys = { publicKey, privateKey }
  return isVapidKeys(keys) ? keys : null
}

export type StoredSubscription = PushSubscriptionKeys & { userId: string }

/**
 * Keeps one browser's subscription against the person signed in to it.
 *
 * Keyed on the endpoint, which is the browser: a second person signing in on
 * the same machine and turning nudges on takes the row over, and the first
 * stops being told about post on a screen they are no longer at.
 */
export async function saveSubscription(userId: string, sub: PushSubscriptionKeys): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "uin_push_subscriptions" ("user_id", "endpoint", "p256dh", "auth")
    VALUES (${userId}, ${sub.endpoint}, ${sub.p256dh}, ${sub.auth})
    ON CONFLICT ("endpoint") DO UPDATE SET
      "user_id" = EXCLUDED."user_id",
      "p256dh" = EXCLUDED."p256dh",
      "auth" = EXCLUDED."auth",
      "updated_at" = now()
  `
}

/** Somebody turning nudges off in one browser. Their own row only: an endpoint
 *  is not a secret worth relying on, so it never removes somebody else's. */
export async function deleteSubscription(userId: string, endpoint: string): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "uin_push_subscriptions" WHERE "endpoint" = ${endpoint} AND "user_id" = ${userId}
  `
}

/** A push service saying a browser is gone for good. */
export async function forgetEndpoint(endpoint: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "uin_push_subscriptions" WHERE "endpoint" = ${endpoint}`
}

export async function listSubscriptions(): Promise<StoredSubscription[]> {
  const rows = await prisma.$queryRaw<{ user_id: string; endpoint: string; p256dh: string; auth: string }[]>`
    SELECT "user_id", "endpoint", "p256dh", "auth" FROM "uin_push_subscriptions" ORDER BY "created_at"
  `
  return rows.map((r) => ({ userId: r.user_id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }))
}

/**
 * Claims every incoming message that has reached the site since `since` and
 * has not been claimed before, and hands back the conversations they are in.
 *
 * The ledger's primary key is the whole of the concurrency story: two rounds
 * finishing at the same moment both try to insert the same message ids, and
 * each id goes to exactly one of them. A message committed after a round looked
 * is simply there for the next - which is at the latest the round the
 * collection that filed it runs itself, because every collection runs one once
 * it has finished filing.
 *
 * Claimed whether or not anybody is subscribed, so the first person to turn
 * nudges on is not greeted with everything that arrived before they did.
 */
export async function claimArrivals(since: Date, writtenAfter: Date): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ thread_id: string }[]>`
    WITH "claimed" AS (
      INSERT INTO "uin_push_nudged" ("message_id")
      SELECT m."id"
        FROM "uin_messages" m
       WHERE m."direction" = 'in'
         AND m."created_at" >= ${since}
         AND m."auto_kind" IS NULL
         AND m."sent_at" >= ${writtenAfter}
      ON CONFLICT ("message_id") DO NOTHING
      RETURNING "message_id"
    )
    SELECT DISTINCT m."thread_id"
      FROM "claimed" c
      JOIN "uin_messages" m ON m."id" = c."message_id"
  `
  return rows.map((r) => r.thread_id)
}

/** The ledger only has to outlive the window a round looks back over. A couple
 *  of days of it is plenty, and anything older is a table nobody meant to grow. */
export async function pruneNudgeLedger(before: Date): Promise<number> {
  return prisma.$executeRaw`DELETE FROM "uin_push_nudged" WHERE "created_at" < ${before}`
}
