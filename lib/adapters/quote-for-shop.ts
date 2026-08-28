import { prisma } from '@/lib/db/prisma'
import type { ContextAdapter, ContextItem, ContextQuery, ContextSection, LinkTarget } from './types'
import { SECTION_LIMIT } from './types'
import { detailLine, humanStatus, inList, shortDate, toDate } from './format'

// Quotes this person has asked for, matched on the address they gave. Only the
// ones still live: a quote that was won became an order and shows up under the
// shop instead, and a quote that was lost is not what somebody answering an
// email needs in front of them.

const LIVE_STATUSES = ['NEW', 'SENT']

export const quotesAdapter: ContextAdapter = {
  moduleName: 'quote-for-shop',
  permission: 'quotes.access',
  tables: ['qfs_quotes'],

  async load(query: ContextQuery): Promise<ContextSection | null> {
    if (query.emails.length === 0) return null

    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT "id", "quote_number", "status", "created_at", "expires_at"
        FROM "qfs_quotes"
       WHERE lower("customer_email") IN (${inList(query.emails)})
         AND "status" IN (${inList(LIVE_STATUSES)})
       ORDER BY "created_at" DESC
       LIMIT ${SECTION_LIMIT}
    `
    const counted = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
        FROM "qfs_quotes"
       WHERE lower("customer_email") IN (${inList(query.emails)})
         AND "status" IN (${inList(LIVE_STATUSES)})
    `
    const total = Number(counted[0]?.count ?? 0)
    if (total === 0) return null

    const items: ContextItem[] = rows.map((r) => ({
      id: r.id as string,
      title: (r.quote_number as string) || 'Quote',
      detail: detailLine(
        shortDate(r.created_at),
        r.expires_at ? `runs out ${shortDate(r.expires_at)}` : null,
      ),
      status: humanStatus(r.status),
      at: toDate(r.created_at),
      href: `quote-for-shop/quotes/${r.id as string}`,
    }))

    return {
      moduleName: 'quote-for-shop',
      label: 'Open quotes',
      items,
      total,
      moreHref: total > items.length ? 'quote-for-shop/quotes' : null,
    }
  },

  async lookup(kind, reference): Promise<LinkTarget | null> {
    if (kind !== 'quote') return null
    const rows = await prisma.$queryRaw<{ id: string; quote_number: string }[]>`
      SELECT "id", "quote_number" FROM "qfs_quotes"
       WHERE upper("quote_number") = ${reference.toUpperCase()}
       LIMIT 1
    `
    const row = rows[0]
    if (!row) return null
    return {
      moduleName: 'quote-for-shop',
      recordType: 'quote',
      recordId: row.id,
      label: `Quote ${row.quote_number}`,
      href: `quote-for-shop/quotes/${row.id}`,
    }
  },
}
