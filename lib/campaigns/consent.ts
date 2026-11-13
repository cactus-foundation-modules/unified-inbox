import { prisma } from '@/lib/db/prisma'
import { normaliseAddress } from '../addresses'

// ---------------------------------------------------------------------------
// Whether somebody has said no to marketing email - asked of every place they
// might have said it, not only their contact card.
//
// A customer can say no in three places on a site running this module:
//
//   Their contact card here - typed in by a colleague after a phone call, or
//   written by the unsubscribe link, or copied across from an order.
//
//   An order in the shop. The checkout's own question, stored on the order.
//   Copied onto the contact card when the order makes or finds a contact - but
//   only when the site has that copying switched on, and only onto a card that
//   already exists. A site that switched it off still has the answer, on the
//   order, and a campaign to the Customers list must not walk past it.
//
//   Their account. Core keeps the latest answer from their own orders on the
//   Member row, "last order wins".
//
// THE NEWEST DATED ANSWER WINS, between the card and the latest order. A
// customer who ticked "no" at checkout in May and then rang in June to say they
// would like the offers after all has said yes, and the card says so with the
// later date. The account's answer carries no date of its own, so it only
// speaks when neither of the other two has anything to say.
//
// Read through to_jsonb() rather than by column name, both in the shop's table
// and in core's: an older shop with no marketing question, or an older core with
// no account column, would otherwise fail the whole read instead of leaving that
// answer out. And the shop's table itself may not exist at all - a site with no
// shop - which is asked first rather than discovered by an error.
// ---------------------------------------------------------------------------

export type DatedAnswer = { consent: boolean; at: Date | null }

export type MarketingAnswers = {
  /** What their contact card says, with when it was said. */
  card: DatedAnswer | null
  /** What their most recent order that asked said, with when it was placed. */
  order: DatedAnswer | null
  /** What their account says. No date: it is only ever a copy of an order. */
  account: boolean | null
}

/**
 * The one answer, from however many there are. True is a yes, false is a no,
 * null is never asked - which a campaign treats as allowed, the same as it
 * always has.
 */
export function effectiveConsent(answers: MarketingAnswers): boolean | null {
  const { card, order, account } = answers
  if (card && order) {
    // Undated loses to dated. Two answers at the same instant are the same
    // answer copied across, or near enough - and if they disagree, no wins,
    // because sending to somebody who said no costs far more than not sending
    // to somebody who said yes.
    const cardAt = card.at?.getTime() ?? -Infinity
    const orderAt = order.at?.getTime() ?? -Infinity
    if (cardAt > orderAt) return card.consent
    if (orderAt > cardAt) return order.consent
    return card.consent && order.consent
  }
  if (card) return card.consent
  if (order) return order.consent
  return account
}

/** Whether the shop's order table is there to be read at all. */
async function hasShopOrders(): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ present: boolean }[]>`
    SELECT to_regclass('"shp_orders"') IS NOT NULL AS present
  `
  return rows[0]?.present === true
}

/**
 * The latest order answer for each of these addresses. Orders whose question
 * was never put (no answer stored) are stepped over, so a later order on a
 * checkout that did not ask does not hide an earlier no.
 */
async function orderAnswersFor(addresses: string[]): Promise<Map<string, DatedAnswer>> {
  const answers = new Map<string, DatedAnswer>()
  if (addresses.length === 0 || !await hasShopOrders()) return answers
  const rows = await prisma.$queryRaw<{ address: string; consent: boolean; at: Date | null }[]>`
    SELECT DISTINCT ON (lower(btrim(o."customer_email")))
           lower(btrim(o."customer_email")) AS address,
           (to_jsonb(o) ->> 'marketing_consent')::boolean AS consent,
           o."created_at" AS at
      FROM "shp_orders" o
     WHERE lower(btrim(o."customer_email")) = ANY(${addresses}::text[])
       AND jsonb_typeof(to_jsonb(o) -> 'marketing_consent') = 'boolean'
     ORDER BY lower(btrim(o."customer_email")), o."created_at" DESC
  `
  for (const row of rows) answers.set(row.address, { consent: row.consent, at: row.at })
  return answers
}

/** The account answer for each of these addresses. Two accounts on one address
 *  (it happens with old imports) and either saying no is a no. */
async function accountAnswersFor(addresses: string[]): Promise<Map<string, boolean>> {
  const answers = new Map<string, boolean>()
  if (addresses.length === 0) return answers
  const rows = await prisma.$queryRaw<{ address: string; consent: boolean }[]>`
    SELECT lower(btrim(m."email")) AS address,
           bool_and((to_jsonb(m) ->> 'marketingConsent')::boolean) AS consent
      FROM "Member" m
     WHERE lower(btrim(m."email")) = ANY(${addresses}::text[])
       AND jsonb_typeof(to_jsonb(m) -> 'marketingConsent') = 'boolean'
     GROUP BY lower(btrim(m."email"))
  `
  for (const row of rows) answers.set(row.address, row.consent)
  return answers
}

/**
 * The order and account answers for a whole list at once - one query each,
 * whatever the length of the list. The card's answer is the caller's: it is
 * already on the row the caller read.
 */
export async function outsideAnswersFor(addresses: readonly string[]): Promise<{
  orders: Map<string, DatedAnswer>
  accounts: Map<string, boolean>
}> {
  const normalised = [...new Set(addresses.map((a) => normaliseAddress(a)).filter(Boolean))]
  const [orders, accounts] = await Promise.all([
    orderAnswersFor(normalised),
    accountAnswersFor(normalised),
  ])
  return { orders, accounts }
}

/**
 * Whether one address has said no, as of now - asked by the runner at the
 * moment of sending, because a customer can opt out at checkout between the
 * list being built and their turn coming round.
 *
 * The card is every live contact holding this address as their own, newest
 * answer first: the contact the campaign was built from may since have been
 * merged into another.
 */
export async function hasOptedOutOfMarketing(address: string): Promise<boolean> {
  const normalised = normaliseAddress(address)
  if (!normalised) return false
  const cards = await prisma.$queryRaw<{ consent: boolean; at: Date | null }[]>`
    SELECT p."marketing_consent" AS consent, p."marketing_consent_at" AS at
      FROM "uin_people" p
     WHERE p."merged_into_id" IS NULL
       AND lower(btrim(p."primary_email")) = ${normalised}
       AND p."marketing_consent" IS NOT NULL
     ORDER BY p."marketing_consent_at" DESC NULLS LAST
     LIMIT 1
  `
  const { orders, accounts } = await outsideAnswersFor([normalised])
  const card = cards[0] ? { consent: cards[0].consent, at: cards[0].at } : null
  return effectiveConsent({
    card,
    order: orders.get(normalised) ?? null,
    account: accounts.get(normalised) ?? null,
  }) === false
}

/**
 * Write a no everywhere this module may write one, for the unsubscribe link.
 *
 * Every live contact holding the address, not only the one an identity lookup
 * finds first - a contact whose address is on their card but was never
 * collected as an identity would otherwise keep saying yes. And the account,
 * through core's own helper, so the customer's account page and the admin's
 * view of it agree with what they just asked for.
 *
 * Returns how many contact cards it changed, for the log line.
 */
export async function recordOptOutEverywhere(address: string, at: Date, source: string): Promise<number> {
  const normalised = normaliseAddress(address)
  if (!normalised) return 0
  const changed = await prisma.$executeRaw`
    UPDATE "uin_people"
       SET "marketing_consent" = FALSE,
           "marketing_consent_at" = ${at},
           "marketing_consent_source" = ${source},
           "updated_at" = now()
     WHERE "merged_into_id" IS NULL
       AND lower(btrim("primary_email")) = ${normalised}
       AND ("marketing_consent" IS DISTINCT FROM FALSE
            OR "marketing_consent_at" IS NULL
            OR "marketing_consent_at" < ${at})
  `
  const members = await prisma.$queryRaw<{ id: string; email: string }[]>`
    SELECT "id", "email" FROM "Member" WHERE lower(btrim("email")) = ${normalised}
  `
  if (members.length > 0) {
    const { syncMemberMarketingConsent } = await import('@/lib/members/marketing-consent')
    for (const member of members) await syncMemberMarketingConsent(member.id, false, member.email)
  }
  return changed
}
