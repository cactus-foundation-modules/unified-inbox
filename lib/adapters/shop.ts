import { prisma } from '@/lib/db/prisma'
import type {
  ContextAdapter, ContextItem, ContextQuery, ContextSection, LinkSuggestion, LinkTarget,
} from './types'
import { SECTION_LIMIT, SUGGEST_LIMIT } from './types'
import { detailLine, humanStatus, inList, likeTerm, money, shortDate, toDate } from './format'
import { getSiteTimezone } from '@/lib/config/timezone'

// What the shop knows about this person: their orders, newest first.
//
// Matched on the email address the order was placed with, which is the only
// handle both sides genuinely share - an order carries a snapshot of the
// customer rather than a live relation, so there is nothing to join on. Case
// folded on our side of the comparison because a shopper types their address
// however they please.

export const shopAdapter: ContextAdapter = {
  moduleName: 'shop',
  permission: 'shop.orders',
  tables: ['shp_orders'],
  linkKind: 'order',
  linkLabel: 'Order',

  async load(query: ContextQuery): Promise<ContextSection | null> {
    const tz = await getSiteTimezone()
    if (query.emails.length === 0) return null

    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT "id", "order_number", "status", "payment_status", "total", "currency",
             "created_at", "customer_name"
        FROM "shp_orders"
       WHERE lower("customer_email") IN (${inList(query.emails)})
       ORDER BY "created_at" DESC
       LIMIT ${SECTION_LIMIT}
    `
    const counted = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
        FROM "shp_orders"
       WHERE lower("customer_email") IN (${inList(query.emails)})
    `
    const total = Number(counted[0]?.count ?? 0)
    if (total === 0) return null

    const items: ContextItem[] = rows.map((r) => ({
      id: r.id as string,
      title: (r.order_number as string) || 'Order',
      detail: detailLine(money(r.total, r.currency as string), shortDate(r.created_at, tz)),
      status: paymentAwareStatus(r.status, r.payment_status),
      at: toDate(r.created_at),
      href: `m/shop/orders/${r.id as string}`,
    }))

    return {
      moduleName: 'shop',
      label: total === 1 ? 'Their order' : 'Their orders',
      items,
      total,
      moreHref: total > items.length ? 'm/shop/orders' : null,
    }
  },

  async lookup(kind, reference): Promise<LinkTarget | null> {
    if (kind !== 'order') return null
    const rows = await prisma.$queryRaw<{ id: string; order_number: string }[]>`
      SELECT "id", "order_number" FROM "shp_orders"
       WHERE upper("order_number") = ${reference.toUpperCase()}
       LIMIT 1
    `
    const row = rows[0]
    if (!row) return null
    return {
      moduleName: 'shop',
      recordType: 'order',
      recordId: row.id,
      label: `Order ${row.order_number}`,
      href: `m/shop/orders/${row.id}`,
    }
  },
  /**
   * Orders to choose from when attaching one to a conversation by hand.
   *
   * With nothing typed this is a browse, and the shopper's own orders come
   * first: somebody answering "where is my desk" wants the order in front of
   * them, not the newest one on the site. Typing searches the number, the name
   * and the address, because the person asking often quotes none of the three
   * exactly and half of one of them.
   */
  async suggest(kind, term, query): Promise<LinkSuggestion[]> {
    const tz = await getSiteTimezone()
    if (kind !== 'order') return []
    const trimmed = term.trim()
    const like = likeTerm(trimmed)
    const emails = query?.emails ?? []

    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT "id", "order_number", "status", "payment_status", "total", "currency",
             "created_at", "customer_name", "customer_email"
        FROM "shp_orders"
       WHERE ${trimmed.length === 0}
          OR "order_number" ILIKE ${like}
          OR "customer_name" ILIKE ${like}
          OR "customer_email" ILIKE ${like}
       ORDER BY (CASE WHEN ${emails.length > 0}
                       AND lower("customer_email") IN (${inList(emails)}) THEN 0 ELSE 1 END) ASC,
                "created_at" DESC
       LIMIT ${SUGGEST_LIMIT}
    `

    return rows.map((r) => ({
      moduleName: 'shop',
      recordType: 'order',
      recordId: r.id as string,
      reference: (r.order_number as string) || '',
      label: `Order ${(r.order_number as string) || ''}`.trim(),
      href: `m/shop/orders/${r.id as string}`,
      detail: detailLine(
        (r.customer_name as string) || null,
        money(r.total, r.currency as string),
        shortDate(r.created_at, tz),
      ),
      status: paymentAwareStatus(r.status, r.payment_status),
    })).filter((row) => row.reference.length > 0)
  },
}

/** An order that has shipped but has not been paid for is the one somebody
 *  needs to see at a glance, so the money wins when the two disagree. */
function paymentAwareStatus(status: unknown, paymentStatus: unknown): string | null {
  const pay = typeof paymentStatus === 'string' ? paymentStatus : ''
  if (pay === 'PENDING' || pay === 'FAILED') return humanStatus(`${pay === 'FAILED' ? 'payment failed' : 'unpaid'}`)
  return humanStatus(status)
}
