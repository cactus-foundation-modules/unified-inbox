import { prisma } from '@/lib/db/prisma'
import type {
  ContextAdapter, ContextItem, ContextQuery, ContextSection, LinkSuggestion, LinkTarget,
} from './types'
import { SECTION_LIMIT, SUGGEST_LIMIT } from './types'
import { detailLine, humanStatus, inList, likeTerm, money, shortDate, toDate } from './format'

// Purchasing's side of the person: which supplier they are, what is on order
// with them, and what they have billed us for that is not settled.
//
// A supplier is matched on their own email address or the domain it sits on,
// because a purchase order carries the supplier's contact and the person
// writing to us is somebody at that supplier - often not the address on file.
// Matching the domain is what makes a reply from an account manager land on the
// right supplier without anybody maintaining a second list.

// Purchasing's own status words, copied rather than imported - importing
// another module's code is the thing this whole folder exists to avoid. A word
// that changes there and not here costs us a row in a side panel, which is the
// cheapest possible way for that coupling to go wrong.
const OPEN_ORDER_STATUSES = ['DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SENT', 'ACKNOWLEDGED', 'PART_RECEIVED', 'ON_HOLD']
// POSTED is booked and VOID is cancelled; the rest are still somebody's problem.
const UNSETTLED_BILL_STATUSES = ['DRAFT', 'QUERIED', 'APPROVED']

export const purchaseOrdersAdapter: ContextAdapter = {
  moduleName: 'purchase-orders',
  permission: 'purchase-orders.access',
  tables: ['po_suppliers', 'po_orders', 'po_bills'],
  linkKind: 'po',
  linkLabel: 'Purchase order',

  async load(query: ContextQuery): Promise<ContextSection | null> {
    if (query.emails.length === 0 && query.domains.length === 0) return null

    const suppliers = await prisma.$queryRaw<{ id: string; name: string }[]>`
      SELECT "id", "name"
        FROM "po_suppliers"
       WHERE (${query.emails.length > 0} AND lower("email") IN (${inList(query.emails)}))
          OR (${query.domains.length > 0} AND split_part(lower("email"), '@', 2) IN (${inList(query.domains)}))
       ORDER BY "name" ASC
       LIMIT 5
    `
    if (suppliers.length === 0) return null
    const supplierIds = suppliers.map((s) => s.id)

    const orders = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT "id", "number", "status", "total", "currency", "raised_date", "expected_date"
        FROM "po_orders"
       WHERE "supplier_id" IN (${inList(supplierIds)})
         AND "status" IN (${inList(OPEN_ORDER_STATUSES)})
       ORDER BY COALESCE("raised_date", "created_at"::date) DESC
       LIMIT ${SECTION_LIMIT}
    `

    const bills = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT "id", "supplier_invoice_number", "status", "total", "currency", "due_date"
        FROM "po_bills"
       WHERE "supplier_id" IN (${inList(supplierIds)})
         AND "status" IN (${inList(UNSETTLED_BILL_STATUSES)})
       ORDER BY "invoice_date" DESC
       LIMIT ${SECTION_LIMIT}
    `

    const items: ContextItem[] = [
      // The supplier itself first: knowing who we think this is matters more
      // than any one order, and it is the thing to correct when we are wrong.
      ...suppliers.map((s) => ({
        id: `supplier:${s.id}`,
        title: s.name,
        detail: 'Supplier on file',
        status: null,
        at: null,
        href: 'm/purchase-orders/suppliers',
      })),
      ...orders.map((r) => ({
        id: `order:${r.id as string}`,
        title: (r.number as string) || 'Purchase order',
        detail: detailLine(
          money(r.total, r.currency as string),
          r.expected_date ? `due ${shortDate(r.expected_date)}` : shortDate(r.raised_date),
        ),
        status: humanStatus(r.status),
        at: toDate(r.raised_date),
        href: `m/purchase-orders/orders/${r.id as string}`,
      })),
      ...bills.map((r) => ({
        id: `bill:${r.id as string}`,
        title: `Bill ${(r.supplier_invoice_number as string) || ''}`.trim(),
        detail: detailLine(
          money(r.total, r.currency as string),
          r.due_date ? `due ${shortDate(r.due_date)}` : null,
        ),
        status: humanStatus(r.status),
        at: toDate(r.due_date),
        href: `m/purchase-orders/bills/${r.id as string}`,
      })),
    ]

    return {
      moduleName: 'purchase-orders',
      label: 'Purchasing',
      items,
      total: items.length,
      moreHref: 'm/purchase-orders/orders',
    }
  },

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
        r.expected_date ? `due ${shortDate(r.expected_date)}` : shortDate(r.raised_date),
      ),
      status: humanStatus(r.status),
    })).filter((row) => row.reference.length > 0)
  },
}
