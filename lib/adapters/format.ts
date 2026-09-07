import { Prisma } from '@prisma/client'
import { formatInSiteTimezone } from '@/lib/config/timezone'

// Turning what a raw query hands back into something a person reads.
//
// The awkward part is money. A NUMERIC column comes out of a Prisma raw query
// as a Decimal rather than a number, and `Number(value)` on one happens to work
// today by way of valueOf - which is a detail of a library we do not own. Going
// through the string is the shape that keeps working, and it is exact.

export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
  const parsed = Number(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

export function money(value: unknown, currency: string | null | undefined): string | null {
  const amount = toNumber(value)
  if (amount === null) return null
  const code = (currency || 'GBP').toUpperCase()
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: code }).format(amount)
  } catch {
    // An unknown currency code is somebody else's data problem, and a panel
    // that throws over it is ours. Show the number and the code.
    return `${amount.toFixed(2)} ${code}`
  }
}

export function shortDate(value: unknown, timezone: string): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) return null
  return formatInSiteTimezone(date, timezone, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function toDate(value: unknown): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date
}

/** SHIPPED -> Shipped, PARTIALLY_REFUNDED -> Partially refunded. Status words
 *  in this codebase are shouted enum values and nobody talks like that. */
export function humanStatus(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return null
  const words = raw.replace(/[_-]+/g, ' ').toLowerCase().trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The pieces of a detail line, minus the empty ones, joined the way a person
 *  would say them. */
export function detailLine(...parts: Array<string | null | undefined>): string | null {
  const kept = parts.filter((p): p is string => !!p && p.trim().length > 0)
  return kept.length > 0 ? kept.join(' - ') : null
}

/**
 * A list of strings for an IN clause.
 *
 * `Prisma.join` on an empty array produces `IN ()`, which is a syntax error
 * rather than an empty result, so an empty list has to become something.
 *
 * It becomes `IN (NULL)`, which is never true and never matches - and, unlike
 * the sentinel string it used to be, is something Postgres will accept. The
 * sentinel began with a NUL character on the reasoning that no real address
 * could ever contain one. Quite right, and the reason is that a text parameter
 * containing a NUL is not a value Postgres will take AT ALL: binding one fails
 * the whole statement with `invalid byte sequence for encoding "UTF8": 0x00`.
 * So every query that reached this branch threw instead of returning nothing,
 * which is how the attach picker came back empty on a conversation with nobody
 * outside it - a discussion between colleagues has no addresses to rank by, and
 * the ranking clause took the whole query down with it.
 *
 * `NOT IN` on this would be a trap - `x NOT IN (NULL)` is NULL rather than true,
 * so nothing would ever match. Nothing in this module writes one, and anything
 * that wants to should say so in SQL rather than reach for this.
 */
export function inList(values: readonly string[]): Prisma.Sql {
  return values.length > 0 ? Prisma.join([...values]) : Prisma.sql`NULL`
}

/**
 * A typed search term as a LIKE pattern.
 *
 * The wildcards are escaped rather than stripped: somebody searching for an
 * order number with an underscore in it means that underscore, and LIKE reads
 * it as "any character" unless told otherwise. Postgres takes a backslash as
 * the escape by default, which is what this writes.
 */
export function likeTerm(term: string): string {
  return `%${term.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}
