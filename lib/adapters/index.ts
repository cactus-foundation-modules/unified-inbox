import { hasPermissions } from '@/lib/permissions/check'
import type { SessionUser } from '@/lib/auth/session'
import { existingTables, installedModuleNames } from '../installed'
import type { LinkKind } from '../linking'
import type { ContextAdapter, ContextQuery, ContextSection, LinkTarget } from './types'
import { shopAdapter } from './shop'
import { purchaseOrdersAdapter } from './purchase-orders'
import { bookkeepingAdapter } from './uk-bookkeeping'
import { quotesAdapter } from './quote-for-shop'
import { membersAdapter } from './members'

export type { ContextAdapter, ContextItem, ContextQuery, ContextSection, LinkTarget } from './types'
export { SECTION_LIMIT } from './types'

/**
 * Every adapter, in the order the rail draws them.
 *
 * Adding one is a file in this folder and a line here. Nothing else in the
 * module knows how many there are or what they read, which is the point: a
 * stage that wants a new record source should not have to touch the panel, the
 * routes or the linker to get one.
 */
export const ADAPTERS: readonly ContextAdapter[] = [
  membersAdapter,
  shopAdapter,
  quotesAdapter,
  purchaseOrdersAdapter,
  bookkeepingAdapter,
]

/**
 * Which adapters can run at all for this viewer, right now.
 *
 * Three gates, cheapest first, and all of them batched: is the module installed
 * (one cached query for the lot), are its tables there (one cached query for
 * the lot), and may this person see that module's records (one query for every
 * permission at once). An adapter that fails any of them costs nothing beyond
 * its share of those three round trips.
 */
export async function usableAdapters(user: SessionUser): Promise<ContextAdapter[]> {
  const wantedTables = [...new Set(ADAPTERS.flatMap((a) => a.tables))]
  const [installed, tables, perms] = await Promise.all([
    installedModuleNames(),
    wantedTables.length > 0 ? existingTables(wantedTables) : Promise.resolve(new Set<string>()),
    hasPermissions(user, [...new Set(ADAPTERS.map((a) => a.permission))]),
  ])

  return ADAPTERS.filter((adapter) => {
    // 'core' is not a module and is never in the installed list.
    if (adapter.moduleName !== 'core' && !installed.has(adapter.moduleName)) return false
    if (!adapter.tables.every((t) => tables.has(t))) return false
    return perms[adapter.permission] === true
  })
}

/**
 * The whole rail for one person.
 *
 * One adapter failing costs that block and nothing else. A side panel that
 * throws takes the conversation down with it, and the conversation is the thing
 * somebody actually came here to read.
 */
export async function loadContext(user: SessionUser, query: ContextQuery): Promise<ContextSection[]> {
  const adapters = await usableAdapters(user)
  const settled = await Promise.all(
    adapters.map(async (adapter) => {
      try {
        return await adapter.load(query)
      } catch (err) {
        console.error(`[unified-inbox] the ${adapter.moduleName} panel could not be read:`, err)
        return null
      }
    }),
  )
  return settled.filter((s): s is ContextSection => s !== null && s.items.length > 0)
}

/**
 * Ask the owning modules whether a reference a pattern proposed is real.
 *
 * This runs on the sync tick with no session, so it deliberately does NOT check
 * anybody's permissions: it is deciding what a conversation is about, not what
 * a particular person may look at. The rail is where the viewer's permissions
 * apply, and a link they may not follow is not rendered for them.
 */
export async function confirmReference(kind: LinkKind, reference: string): Promise<LinkTarget | null> {
  const wantedTables = [...new Set(ADAPTERS.flatMap((a) => a.tables))]
  const [installed, tables] = await Promise.all([
    installedModuleNames(),
    wantedTables.length > 0 ? existingTables(wantedTables) : Promise.resolve(new Set<string>()),
  ])

  for (const adapter of ADAPTERS) {
    if (!adapter.lookup) continue
    if (adapter.moduleName !== 'core' && !installed.has(adapter.moduleName)) continue
    if (!adapter.tables.every((t) => tables.has(t))) continue
    try {
      const found = await adapter.lookup(kind, reference)
      if (found) return found
    } catch (err) {
      console.error(`[unified-inbox] could not check ${reference} against ${adapter.moduleName}:`, err)
    }
  }
  return null
}
