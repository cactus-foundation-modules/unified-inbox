import { prisma } from '@/lib/db/prisma'
import type { ContextAdapter, ContextItem, ContextQuery, ContextSection, LinkTarget } from './types'
import { SECTION_LIMIT } from './types'
import { detailLine, humanStatus, inList, money, shortDate, toDate } from './format'

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

  async load(query: ContextQuery): Promise<ContextSection | null> {
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
      detail: detailLine(money(r.total, r.currency as string), shortDate(r.created_at)),
      status: paymentAwareStatus(r.status, r.payment_status),
      at: toDate(r.created_at),
      href: `shop/orders/${r.id as string}`,
    }))

    return {
      moduleName: 'shop',
      label: total === 1 ? 'Their order' : 'Their orders',
      items,
      total,
      moreHref: total > items.length ? 'shop/orders' : null,
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
      href: `shop/orders/${row.id}`,
    }
  },
}

/** An order that has shipped but has not been paid for is the one somebody
 *  needs to see at a glance, so the money wins when the two disagree. */
function paymentAwareStatus(status: unknown, paymentStatus: unknown): string | null {
  const pay = typeof paymentStatus === 'string' ? paymentStatus : ''
  if (pay === 'PENDING' || pay === 'FAILED') return humanStatus(`${pay === 'FAILED' ? 'payment failed' : 'unpaid'}`)
  return humanStatus(status)
}
