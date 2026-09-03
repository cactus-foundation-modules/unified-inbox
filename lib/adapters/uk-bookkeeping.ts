import { prisma } from '@/lib/db/prisma'
import type { ContextAdapter, ContextItem, ContextQuery, ContextSection } from './types'
import { SECTION_LIMIT } from './types'
import { detailLine, humanStatus, inList, shortDate, toDate } from './format'
import { getSiteTimezone } from '@/lib/config/timezone.server'

// The books' side of the person: what is on account with them and not settled.
//
// Bookkeeping has no email address on a transaction - it has a counterparty
// NAME, which is how a bank statement describes the other side. So the match is
// on the organisation name we worked out from the mail domain, plus any alias
// the owner has taught the books, which is the same handle a human would use.
//
// A conversation with somebody whose organisation we have not named shows
// nothing here, and that is the honest answer rather than a guess: matching a
// person's surname against a counterparty is how a supplier's unpaid bills end
// up beside a customer's enquiry.

export const bookkeepingAdapter: ContextAdapter = {
  moduleName: 'uk-bookkeeping',
  permission: 'bookkeeping.access',
  tables: ['bk_transactions', 'bk_counterparty_aliases'],

  async load(query: ContextQuery): Promise<ContextSection | null> {
    const tz = await getSiteTimezone()
    const handles = counterpartyHandles(query)
    if (handles.length === 0) return null

    // An alias is what the owner has taught the books about a name written a
    // different way on a statement, so it resolves to the real counterparty
    // before anything is counted.
    const aliased = await prisma.$queryRaw<{ counterparty: string }[]>`
      SELECT DISTINCT "counterparty"
        FROM "bk_counterparty_aliases"
       WHERE lower("alias") IN (${inList(handles)})
    `
    const names = [...new Set([...handles, ...aliased.map((a) => a.counterparty.toLowerCase())])]

    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT "id", "counterparty", "description", "reference", "direction",
             "tax_point_date", "status"
        FROM "bk_transactions"
       WHERE lower("counterparty") IN (${inList(names)})
         AND "settled_date" IS NULL
       ORDER BY "tax_point_date" DESC
       LIMIT ${SECTION_LIMIT}
    `
    const counted = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
        FROM "bk_transactions"
       WHERE lower("counterparty") IN (${inList(names)})
         AND "settled_date" IS NULL
    `
    const total = Number(counted[0]?.count ?? 0)
    if (total === 0) return null

    const items: ContextItem[] = rows.map((r) => ({
      id: r.id as string,
      title: (r.reference as string) || (r.description as string) || 'Entry',
      detail: detailLine(
        r.direction === 'income' ? 'They owe us' : 'We owe them',
        shortDate(r.tax_point_date, tz),
      ),
      status: humanStatus(r.status),
      at: toDate(r.tax_point_date),
      href: `m/uk-bookkeeping/transactions/${r.id as string}`,
    }))

    return {
      moduleName: 'uk-bookkeeping',
      label: 'Outstanding on the books',
      items,
      total,
      moreHref: total > items.length ? 'm/uk-bookkeeping/transactions' : null,
    }
  },
}

/** The names worth asking the books about: the organisation, lower cased. */
function counterpartyHandles(query: ContextQuery): string[] {
  const name = query.organisationName?.trim().toLowerCase()
  return name ? [name] : []
}
