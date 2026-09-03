import { prisma } from '@/lib/db/prisma'
import type {
  ContextAdapter, ContextItem, ContextQuery, ContextSection, LinkSuggestion, LinkTarget,
} from './types'
import { SECTION_LIMIT, SUGGEST_LIMIT } from './types'
import { detailLine, humanStatus, inList, likeTerm, shortDate, toDate } from './format'
import { getSiteTimezone } from '@/lib/config/timezone.server'

// Quotes this person has asked for, matched on the address they gave. Only the
// ones still live: a quote that was won became an order and shows up under the
// shop instead, and a quote that was lost is not what somebody answering an
// email needs in front of them.

const LIVE_STATUSES = ['NEW', 'SENT']

export const quotesAdapter: ContextAdapter = {
  moduleName: 'quote-for-shop',
  permission: 'quotes.access',
  tables: ['qfs_quotes'],
  linkKind: 'quote',
  linkLabel: 'Quote',

  async load(query: ContextQuery): Promise<ContextSection | null> {
    const tz = await getSiteTimezone()
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
        shortDate(r.created_at, tz),
        r.expires_at ? `runs out ${shortDate(r.expires_at, tz)}` : null,
      ),
      status: humanStatus(r.status),
      at: toDate(r.created_at),
      href: `m/quote-for-shop/quotes/${r.id as string}`,
    }))

    return {
      moduleName: 'quote-for-shop',
      label: 'Open quotes',
      items,
      total,
      moreHref: total > items.length ? 'm/quote-for-shop/quotes' : null,
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
      href: `m/quote-for-shop/quotes/${row.id}`,
    }
  },

  /** Quotes to choose from when attaching one by hand. Unlike the panel above
   *  this does not hide the settled ones: a conversation about a quote that was
   *  turned down is exactly the conversation somebody wants it attached to. */
  async suggest(kind, term, query): Promise<LinkSuggestion[]> {
    const tz = await getSiteTimezone()
    if (kind !== 'quote') return []
    const trimmed = term.trim()
    const like = likeTerm(trimmed)
    const emails = query?.emails ?? []

    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT "id", "quote_number", "status", "created_at", "expires_at",
             "customer_name", "customer_email"
        FROM "qfs_quotes"
       WHERE ${trimmed.length === 0}
          OR "quote_number" ILIKE ${like}
          OR "customer_name" ILIKE ${like}
          OR "customer_email" ILIKE ${like}
       ORDER BY (CASE WHEN ${emails.length > 0}
                       AND lower("customer_email") IN (${inList(emails)}) THEN 0 ELSE 1 END) ASC,
                "created_at" DESC
       LIMIT ${SUGGEST_LIMIT}
    `

    return rows.map((r) => ({
      moduleName: 'quote-for-shop',
      recordType: 'quote',
      recordId: r.id as string,
      reference: (r.quote_number as string) || '',
      label: `Quote ${(r.quote_number as string) || ''}`.trim(),
      href: `m/quote-for-shop/quotes/${r.id as string}`,
      detail: detailLine((r.customer_name as string) || null, shortDate(r.created_at, tz)),
      status: humanStatus(r.status),
    })).filter((row) => row.reference.length > 0)
  },
}
