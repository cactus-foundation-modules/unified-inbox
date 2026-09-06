import { prisma } from '@/lib/db/prisma'
import type { ContextAdapter, LinkSuggestion, LinkTarget } from './types'
import { SUGGEST_LIMIT } from './types'
import { detailLine, humanStatus, inList, likeTerm, money, shortDate } from './format'
import { getSiteTimezone } from '@/lib/config/timezone.server'

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
