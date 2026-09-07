import { hasPermissions } from '@/lib/permissions/check'
import type { SessionUser } from '@/lib/auth/session'
import { existingTables, installedModuleNames } from '../installed'
import { shopProducts } from './shop'
import type { ProductChoice, ProductRef, ProductSource, ResolvedProduct } from './types'
import { PRODUCT_SEARCH_LIMIT } from './types'

export type {
  ProductChoice, ProductKind, ProductLink, ProductRef, ProductSource, ResolvedProduct,
} from './types'
export { MAX_PRODUCTS_PER_MESSAGE, PRODUCT_SEARCH_LIMIT } from './types'

/**
 * Every module whose products can go on a message.
 *
 * Adding one is a file in this folder and a line here. Nothing else in the
 * module knows how many there are or what they read - the picker, the send path
 * and the renderer all work in terms of the shapes in ./types.ts.
 */
export const PRODUCT_SOURCES: readonly ProductSource[] = [shopProducts]

/**
 * Which sources can run at all for this viewer, right now.
 *
 * The same three gates the context rail applies, cheapest first and all of them
 * batched: is the module installed, are its tables there, and may this person
 * see that module's products. Somebody who may answer the post but may not open
 * the catalogue is not handed the catalogue through a composer.
 */
export async function usableProductSources(user: SessionUser): Promise<ProductSource[]> {
  const wantedTables = [...new Set(PRODUCT_SOURCES.flatMap((s) => s.tables))]
  const [installed, tables, perms] = await Promise.all([
    installedModuleNames(),
    wantedTables.length > 0 ? existingTables(wantedTables) : Promise.resolve(new Set<string>()),
    hasPermissions(user, [...new Set(PRODUCT_SOURCES.map((s) => s.permission))]),
  ])

  return PRODUCT_SOURCES.filter((source) => {
    if (!installed.has(source.moduleName)) return false
    if (!source.tables.every((t) => tables.has(t))) return false
    return perms[source.permission] === true
  })
}

/** Whether there is anything at all to put on a message here, which is what
 *  decides whether the composer draws the button. */
export async function canAddProducts(user: SessionUser): Promise<boolean> {
  return (await usableProductSources(user)).length > 0
}

/**
 * What somebody could mean, across every module that sells anything.
 *
 * One source failing costs that source and nothing else: a composer that will
 * not open because a catalogue query went wrong is a reply nobody can send.
 */
export async function searchProducts(user: SessionUser, term: string): Promise<ProductChoice[]> {
  const sources = await usableProductSources(user)
  const settled = await Promise.all(
    sources.map(async (source) => {
      try {
        return await source.search(term, PRODUCT_SEARCH_LIMIT)
      } catch (err) {
        console.error(`[unified-inbox] could not list ${source.moduleName} products:`, err)
        return [] as ProductChoice[]
      }
    }),
  )
  return settled.flat().slice(0, PRODUCT_SEARCH_LIMIT)
}

/** The variations of one listing, for picking one exactly. */
export async function listVariations(
  user: SessionUser,
  moduleName: string,
  productId: string,
): Promise<ProductChoice[]> {
  const source = (await usableProductSources(user)).find((s) => s.moduleName === moduleName)
  if (!source) return []
  try {
    return await source.variations(productId)
  } catch (err) {
    console.error(`[unified-inbox] could not list ${moduleName} variations:`, err)
    return []
  }
}

/**
 * Where the customer would see each of these, keyed `moduleName:kind:id`.
 *
 * Not gated on anybody's permissions, for the plainer of the two reasons
 * resolveProducts is not: every address it hands back is a page anybody on the
 * internet may open, and whoever is asking is already looking at the product's
 * name on their own screen.
 */
export async function productPageUrls(
  refs: readonly ProductRef[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (refs.length === 0) return out
  const wantedTables = [...new Set(PRODUCT_SOURCES.flatMap((s) => s.tables))]
  const [installed, tables] = await Promise.all([
    installedModuleNames(),
    wantedTables.length > 0 ? existingTables(wantedTables) : Promise.resolve(new Set<string>()),
  ])

  const settled = await Promise.all(
    PRODUCT_SOURCES.map(async (source) => {
      const mine = refs.filter((r) => r.moduleName === source.moduleName)
      if (mine.length === 0) return null
      if (!installed.has(source.moduleName)) return null
      if (!source.tables.every((t) => tables.has(t))) return null
      try {
        return { source, found: await source.pageUrls(mine) }
      } catch (err) {
        console.error(`[unified-inbox] could not address the ${source.moduleName} products on a conversation:`, err)
        return null
      }
    }),
  )

  for (const answer of settled) {
    if (!answer) continue
    for (const [key, url] of answer.found) out.set(`${answer.source.moduleName}:${key}`, url)
  }
  return out
}

/**
 * The chosen products, as they stand at the moment the message goes.
 *
 * Deliberately NOT gated on anybody's permissions, and for the same reason the
 * automatic linker is not: this runs on the send path, which includes the cron
 * tick that posts a message somebody scheduled for seven in the morning and is
 * not there to have permissions. What it may read was settled when the person
 * picked it; this is only printing what they picked.
 */
export async function resolveProducts(refs: readonly ProductRef[]): Promise<ResolvedProduct[]> {
  if (refs.length === 0) return []
  const wantedTables = [...new Set(PRODUCT_SOURCES.flatMap((s) => s.tables))]
  const [installed, tables] = await Promise.all([
    installedModuleNames(),
    wantedTables.length > 0 ? existingTables(wantedTables) : Promise.resolve(new Set<string>()),
  ])

  const settled = await Promise.all(
    PRODUCT_SOURCES.map(async (source) => {
      const mine = refs.filter((r) => r.moduleName === source.moduleName)
      if (mine.length === 0) return [] as ResolvedProduct[]
      if (!installed.has(source.moduleName)) return [] as ResolvedProduct[]
      if (!source.tables.every((t) => tables.has(t))) return [] as ResolvedProduct[]
      try {
        return await source.resolve(mine)
      } catch (err) {
        console.error(`[unified-inbox] could not read the ${source.moduleName} products on a message:`, err)
        return [] as ResolvedProduct[]
      }
    }),
  )

  // Back into the order they were picked in, which is the order they were meant
  // to be read in. Anything a source could not find is simply not here.
  const byKey = new Map(
    settled.flat().map((r) => [`${r.choice.moduleName}:${r.choice.kind}:${r.choice.id}`, r]),
  )
  return refs
    .map((ref) => byKey.get(`${ref.moduleName}:${ref.kind}:${ref.id}`))
    .filter((r): r is ResolvedProduct => r !== undefined)
}
