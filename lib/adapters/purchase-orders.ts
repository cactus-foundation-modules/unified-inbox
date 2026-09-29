import { prisma } from '@/lib/db/prisma'
import type { ContextAdapter, LinkSuggestion, LinkTarget } from './types'
import { SUGGEST_LIMIT } from './types'
import { detailLine, humanStatus, inList, likeTerm, money, shortDate } from './format'
import { getSiteTimezone } from '@/lib/config/timezone.server'
import { existingTables, installedModuleNames } from '../installed'

// Purchasing's side of a conversation: which purchase order it is about.
//
// There is deliberately no `load` here, so purchasing draws no block of its own
// in the panel beside a conversation. It used to draw one - the supplier, their
// open orders, their unsettled bills - and beside a supplier thread that was a
// second, longer copy of the purchase order already attached to the
// conversation and named in its header, pushed under the messages on any window
// narrower than a very wide one. What is left is the half that earns its keep:
// spotting a PO number in a message and offering the right orders when somebody
// attaches one by hand.

export const purchaseOrdersAdapter: ContextAdapter = {
  moduleName: 'purchase-orders',
  permission: 'purchase-orders.access',
  // Bills are no longer read from here, so they are no longer a condition of
  // spotting a PO number in a message.
  tables: ['po_suppliers', 'po_orders'],
  linkKind: 'po',
  linkLabel: 'Purchase order',

  async lookup(kind, reference): Promise<LinkTarget | null> {
    if (kind !== 'po') return null
    const rows = await prisma.$queryRaw<{ id: string; number: string }[]>`
      SELECT "id", "number" FROM "po_orders"
       WHERE upper("number") = ${reference.toUpperCase()}
       LIMIT 1
    `
    const row = rows[0]
    if (!row) return null
    return {
      moduleName: 'purchase-orders',
      recordType: 'purchase-order',
      recordId: row.id,
      label: `Purchase order ${row.number}`,
      href: `m/purchase-orders/orders/${row.id}`,
    }
  },

  /**
   * A purchase order raised from a shop order, and that shop order, belong on
   * a conversation together: a supplier writing about the PO is writing about
   * somebody's order, and a customer chasing an order is waiting on the PO. So
   * attaching either one brings the other along. The tie is the one purchasing
   * writes when it raises a PO from an order (`source_ref.orderId`).
   *
   * The shop's table is checked for rather than assumed - purchasing is often
   * installed on a site with no shop at all.
   */
  async related(record): Promise<LinkTarget[]> {
    const toOrder = record.moduleName === 'purchase-orders' && record.recordType === 'purchase-order'
    const toPos = record.moduleName === 'shop' && record.recordType === 'order'
    if (!toOrder && !toPos) return []
    const [installed, tables] = await Promise.all([installedModuleNames(), existingTables(['shp_orders'])])
    if (!installed.has('shop') || !tables.has('shp_orders')) return []

    if (toOrder) {
      const rows = await prisma.$queryRaw<{ id: string; order_number: string }[]>`
        SELECT so."id", so."order_number"
          FROM "po_orders" o
          JOIN "shp_orders" so ON so."id" = o."source_ref"->>'orderId'
         WHERE o."id" = ${record.recordId}
      `
      return rows.map((row) => ({
        moduleName: 'shop',
        recordType: 'order',
        recordId: row.id,
        label: `Order ${row.order_number}`,
        href: `m/shop/orders/${row.id}`,
      }))
    }

    const rows = await prisma.$queryRaw<{ id: string; number: string }[]>`
      SELECT "id", "number" FROM "po_orders"
       WHERE "source_ref"->>'orderId' = ${record.recordId}
       ORDER BY "created_at" ASC
    `
    return rows.map((row) => ({
      moduleName: 'purchase-orders',
      recordType: 'purchase-order',
      recordId: row.id,
      label: `Purchase order ${row.number}`,
      href: `m/purchase-orders/orders/${row.id}`,
    }))
  },

  /**
   * Purchase orders to choose from when attaching one by hand.
   *
   * The supplier's own orders come first when we know who is writing - which is
   * the whole point on an inbox that purchasing sends from, where the thread is
   * a supplier answering a PO and the PO wanted is one of the handful open with
   * them. Typing searches the number and the supplier's name; a supplier's own
   * reference for the job is not ours to search.
   */
  async suggest(kind, term, query): Promise<LinkSuggestion[]> {
    const tz = await getSiteTimezone()
    if (kind !== 'po') return []
    const trimmed = term.trim()
    const like = likeTerm(trimmed)
    const emails = query?.emails ?? []
    const domains = query?.domains ?? []

    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT o."id", o."number", o."status", o."total", o."currency", o."raised_date",
             o."expected_date", s."name" AS "supplier_name", s."email" AS "supplier_email"
        FROM "po_orders" o
        LEFT JOIN "po_suppliers" s ON s."id" = o."supplier_id"
       WHERE ${trimmed.length === 0}
          OR o."number" ILIKE ${like}
          OR s."name" ILIKE ${like}
       ORDER BY (CASE WHEN (${emails.length > 0} AND lower(s."email") IN (${inList(emails)}))
                        OR (${domains.length > 0}
                            AND split_part(lower(s."email"), '@', 2) IN (${inList(domains)}))
                      THEN 0 ELSE 1 END) ASC,
                COALESCE(o."raised_date", o."created_at"::date) DESC
       LIMIT ${SUGGEST_LIMIT}
    `

    return rows.map((r) => ({
      moduleName: 'purchase-orders',
      recordType: 'purchase-order',
      recordId: r.id as string,
      reference: (r.number as string) || '',
      label: `Purchase order ${(r.number as string) || ''}`.trim(),
      href: `m/purchase-orders/orders/${r.id as string}`,
      detail: detailLine(
        (r.supplier_name as string) || null,
        money(r.total, r.currency as string),
        r.expected_date ? `due ${shortDate(r.expected_date, tz)}` : shortDate(r.raised_date, tz),
      ),
      status: humanStatus(r.status),
    })).filter((row) => row.reference.length > 0)
  },
}
