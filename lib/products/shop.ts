import { prisma } from '@/lib/db/prisma'
import { getSiteUrlOrNull } from '@/lib/config/env'
import { existingTables, installedModuleNames } from '../installed'
import { inList, likeTerm, toNumber } from '../adapters/format'
import {
  PLAIN_PRICE_DISPLAY,
  displayAmount,
  effectivePrice,
  formatPrice,
  taxSuffix,
  type PriceDisplay,
} from './price'
import type { ProductChoice, ProductSource, ResolvedProduct } from './types'
import { VARIATION_LIMIT } from './types'

// What the shop sells, for putting on a message.
//
// Raw SQL throughout and no import of the shop's own code - the rule this whole
// folder is written under, and the reason a site that uninstalls the shop gets
// a picker with nothing in it rather than a build that will not start.
//
// Variations are the interesting half. A variation is a hidden child row in the
// shop's own product table, joined to its parent by shop-variations, so the
// listing and the exact variation are both products and both link to a page the
// customer can buy from. Where shop-variations is not installed - or its tables
// have not been migrated yet - every listing simply reports no variations, and
// the picker offers listings only. Nothing here fails over the absence.

/** The tables shop-variations must have before a variation query is worth
 *  running. Checked at the point of use rather than declared on the source: the
 *  shop is what this reads, and variations are a bonus on top of it. */
const VARIATION_TABLES = ['svr_variants', 'svr_variant_values', 'svr_options', 'svr_option_values']

type ShopSettings = {
  display: PriceDisplay
  currencySymbol: string
  /** Rate per tax-class id in the shop's default zone, as a fraction. A class
   *  that is absent, and a product with no class at all, is zero-rated. */
  rates: Map<string, number>
  saleEnabled: boolean
  /** Where a product page lives on this site. */
  rootStyle: boolean
  /** The site's own address, or null when there is none to hang a link off. */
  siteUrl: string | null
}

/**
 * Everything about money and addresses that is the same for every line.
 *
 * Read once per request rather than once per product, and never cached beyond
 * it: a shop that has just changed its VAT setting should not send the next
 * five minutes of quotations under the old one.
 *
 * Every read is allowed to fail into the inert answer. A shop whose settings
 * row cannot be read still has products worth putting on a message; it simply
 * quotes them exactly as they are stored and says nothing about tax, which is
 * the only honest thing to say when you do not know.
 */
async function readSettings(): Promise<ShopSettings> {
  const inert: ShopSettings = {
    display: PLAIN_PRICE_DISPLAY,
    currencySymbol: '£',
    rates: new Map(),
    saleEnabled: false,
    rootStyle: false,
    siteUrl: getSiteUrlOrNull(),
  }

  const rows = await prisma
    .$queryRaw<{ config: unknown }[]>`
      SELECT "config" FROM "shp_settings" WHERE "id" = 'singleton' LIMIT 1
    `
    .catch(() => [] as { config: unknown }[])

  const config = (rows[0]?.config ?? {}) as Record<string, unknown>
  const mode = config.priceDisplayTax
  const display: PriceDisplay = {
    mode: mode === 'INCLUSIVE' || mode === 'EXCLUSIVE' ? mode : 'AS_ENTERED',
    // The shop's default is inclusive, and so is ours: a shop that has never
    // opened the setting keeps prices with the tax in them.
    storedIncludesTax: config.taxMode !== 'EXCLUSIVE',
    // The shop's invoice wording, so a message and an invoice from the same
    // site call the tax the same thing. Not the storefront's price suffix,
    // which is a different sentence - see taxSuffix in ./price.ts.
    taxLabel: typeof config.invoiceTaxLabel === 'string' && config.invoiceTaxLabel.trim()
      ? config.invoiceTaxLabel.trim()
      : 'VAT',
  }
  const settings: ShopSettings = {
    ...inert,
    display,
    currencySymbol: typeof config.currencySymbol === 'string' && config.currencySymbol
      ? config.currencySymbol
      : '£',
    saleEnabled: Array.isArray(config.enabledPriceTypes) && config.enabledPriceTypes.includes('sale'),
    rootStyle: config.productUrlStyle === 'ROOT',
  }

  // The rate comes from the shop's DEFAULT zone - the catch-all with no
  // postcodes on it, or failing that the first by name, which is exactly how
  // the shop itself picks one. A catalogue price is quoted long before anybody
  // knows where the parcel is going, so there is no more honest answer.
  const zones = await prisma
    .$queryRaw<{ id: string; postcodes: unknown }[]>`
      SELECT "id", "postcodes" FROM "shp_shipping_zones" ORDER BY "name" ASC
    `
    .catch(() => [] as { id: string; postcodes: unknown }[])
  const zone = zones.find((z) => Array.isArray(z.postcodes) && z.postcodes.length === 0) ?? zones[0]
  if (!zone) return settings

  const rates = await prisma
    .$queryRaw<{ tax_class_id: string; rate: unknown }[]>`
      SELECT "tax_class_id", "rate" FROM "shp_tax_zone_rates" WHERE "zone_id" = ${zone.id}
    `
    .catch(() => [] as { tax_class_id: string; rate: unknown }[])
  for (const row of rates) {
    const value = toNumber(row.rate)
    if (value !== null) settings.rates.set(row.tax_class_id, value)
  }
  return settings
}

/** Whether shop-variations is here and its tables have actually been built. */
async function variationsAvailable(): Promise<boolean> {
  const [installed, tables] = await Promise.all([
    installedModuleNames(),
    existingTables(VARIATION_TABLES),
  ])
  if (!installed.has('shop-variations')) return false
  return VARIATION_TABLES.every((t) => tables.has(t))
}

/**
 * A media url made absolute, or null where it cannot safely be one.
 *
 * An inbox has no origin to resolve `/media/...` against, so a site-relative
 * src that reaches an `<img>` unqualified is a broken picture in every mail
 * client there is. Anything that is neither http(s) nor site-relative is
 * dropped rather than emitted.
 */
function absoluteImage(url: unknown, siteUrl: string | null): string | null {
  const value = typeof url === 'string' ? url.trim() : ''
  if (!value) return null
  if (/^https?:\/\//i.test(value)) return value
  if (!value.startsWith('/')) return null
  return siteUrl ? `${siteUrl}${value}` : null
}

/** The absolute address of a product's own page. A variation's slug is the
 *  hidden child's, which is the address the shop itself publishes - opening the
 *  parent's page with that variation already chosen. Null with no site address
 *  to hang it off: a relative link in somebody else's inbox goes nowhere. */
function productPage(slug: unknown, settings: ShopSettings): string | null {
  const value = typeof slug === 'string' ? slug.trim() : ''
  if (!value || !settings.siteUrl) return null
  const path = settings.rootStyle
    ? `/${encodeURIComponent(value)}`
    : `/shop/products/${encodeURIComponent(value)}`
  return `${settings.siteUrl}${path}`
}

/**
 * The option pairs off a variation row, believed only where they are the shape
 * they are supposed to be.
 *
 * Prisma hands a jsonb column back already parsed, and json_agg over nothing at
 * all is NULL rather than an empty array - so a variation with no options is a
 * null here, not a []. Nothing is guessed: a row that does not look right
 * contributes no filter rather than a filter made of nonsense.
 */
function readOptionPairs(value: unknown): { option: string; value: string }[] {
  if (!Array.isArray(value)) return []
  const out: { option: string; value: string }[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const pair = entry as { option?: unknown; value?: unknown }
    const option = typeof pair.option === 'string' ? pair.option.trim() : ''
    const label = typeof pair.value === 'string' ? pair.value.trim() : ''
    if (!option || !label) continue
    out.push({ option, value: label })
  }
  return out
}

/** One product row as something the picker can draw and the email can print. */
function toChoice(
  row: Record<string, unknown>,
  settings: ShopSettings,
  extras: {
    kind: 'product' | 'variation'
    options?: string | null
    /** The same options taken apart, for narrowing a long list of variations. */
    optionPairs?: { option: string; value: string }[]
    /** The cheapest of several, where this listing has variations. */
    from?: { amount: number; varies: boolean } | null
    variationCount?: number
  },
): ProductChoice {
  const taxClassId = typeof row.tax_class_id === 'string' ? row.tax_class_id : null
  const rate = taxClassId ? settings.rates.get(taxClassId) ?? 0 : 0
  const own = effectivePrice(
    toNumber(row.price) ?? 0,
    toNumber(row.sale_price),
    settings.saleEnabled,
  )
  // A listing with variations is quoted from its cheapest variation, because
  // the listing's own price is a figure the storefront never shows.
  const amount = extras.from ? extras.from.amount : own
  // Nothing at all rather than "£0.00". A listing whose variations are all
  // switched off, and a product priced at zero because its real prices live
  // somewhere else, are both shops saying "not from here" - and a customer sent
  // an email quoting them nothing would be entitled to hold us to it.
  const quotable = amount > 0
  return {
    moduleName: 'shop',
    kind: extras.kind,
    id: row.id as string,
    name: (row.name as string) || 'Product',
    options: extras.options ?? null,
    optionPairs: extras.optionPairs ?? [],
    price: quotable
      ? formatPrice(displayAmount(amount, settings.display, rate), settings.currencySymbol)
      : null,
    priceFrom: quotable && (extras.from?.varies ?? false),
    priceSuffix: quotable ? taxSuffix(settings.display, rate) : null,
    imageUrl: absoluteImage(row.image_url, settings.siteUrl),
    url: productPage(row.slug, settings),
    sku: typeof row.sku === 'string' && row.sku.trim() ? row.sku.trim() : null,
    variationCount: extras.variationCount ?? 0,
  }
}

/** The cheapest and dearest a listing can be bought for, per parent id, over
 *  its switched-on variations only. A variation that is switched off is not on
 *  sale, so it has no business setting a "from" figure. */
async function fromPrices(
  productIds: string[],
  settings: ShopSettings,
): Promise<Map<string, { amount: number; varies: boolean; count: number }>> {
  const out = new Map<string, { amount: number; varies: boolean; count: number }>()
  if (productIds.length === 0 || !(await variationsAvailable())) return out

  const rows = await prisma
    .$queryRaw<Record<string, unknown>[]>`
      SELECT v."product_id",
             COUNT(*)::bigint AS "count",
             MIN(CASE WHEN ${settings.saleEnabled}
                       AND c."sale_price" IS NOT NULL
                       AND c."sale_price" >= 0
                       AND c."sale_price" < c."price"
                      THEN c."sale_price" ELSE c."price" END) AS "cheapest",
             MAX(CASE WHEN ${settings.saleEnabled}
                       AND c."sale_price" IS NOT NULL
                       AND c."sale_price" >= 0
                       AND c."sale_price" < c."price"
                      THEN c."sale_price" ELSE c."price" END) AS "dearest"
        FROM "svr_variants" v
        JOIN "shp_products" c ON c."id" = v."child_product_id"
       WHERE v."enabled" = true
         AND v."product_id" IN (${inList(productIds)})
       GROUP BY v."product_id"
    `
    .catch(() => [] as Record<string, unknown>[])

  for (const row of rows) {
    const cheapest = toNumber(row.cheapest)
    const dearest = toNumber(row.dearest)
    const count = Number(row.count ?? 0)
    if (cheapest === null || count === 0) continue
    out.set(row.product_id as string, {
      amount: cheapest,
      // Only a real spread is a range. Where every variation costs the same the
      // price is stated flat out rather than "from", and half a penny of
      // tolerance keeps floating-point crumbs from inventing a range of nothing.
      varies: (dearest ?? cheapest) - cheapest > 0.005,
      count,
    })
  }
  return out
}

export const shopProducts: ProductSource = {
  moduleName: 'shop',
  permission: 'shop.products',
  tables: ['shp_products', 'shp_product_media', 'shp_settings'],

  /**
   * What somebody could mean.
   *
   * Only what a customer could actually be sent to: published, and never one of
   * the hidden child rows that back a variation - those are reached by opening
   * their listing, which is what the picker offers instead. Nothing typed is a
   * browse rather than an empty answer, and it leads on what sells: the thing
   * being written about is more often the popular one than the newest one.
   */
  async search(term, limit): Promise<ProductChoice[]> {
    const settings = await readSettings()
    const trimmed = term.trim()
    const like = likeTerm(trimmed)

    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT p."id", p."name", p."slug", p."sku", p."price", p."sale_price", p."tax_class_id",
             (SELECT m."url" FROM "shp_product_media" m
               WHERE m."product_id" = p."id" AND m."type" = 'IMAGE'
               ORDER BY m."is_primary" DESC, m."position" ASC
               LIMIT 1) AS "image_url"
        FROM "shp_products" p
       WHERE p."status" = 'ACTIVE'
         AND p."catalogue_hidden" = false
         AND (${trimmed.length === 0}
              OR p."name" ILIKE ${like}
              OR p."sku" ILIKE ${like})
       ORDER BY p."popularity" DESC NULLS LAST, p."name" ASC
       LIMIT ${limit}
    `

    const from = await fromPrices(rows.map((r) => r.id as string), settings)
    return rows.map((row) => {
      const range = from.get(row.id as string) ?? null
      return toChoice(row, settings, {
        kind: 'product',
        from: range,
        variationCount: range?.count ?? 0,
      })
    })
  },

  /**
   * The variations of one listing.
   *
   * Switched-off variations are left out: they cannot be bought, and offering
   * one is offering to quote a customer for something the checkout will refuse.
   * The options that make each one - 'Black / High back' - are read out of
   * shop-variations in the order the shop arranged them, so the wording matches
   * the product page the link goes to.
   */
  async variations(productId): Promise<ProductChoice[]> {
    if (!(await variationsAvailable())) return []
    const settings = await readSettings()

    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT c."id", c."name", c."slug", c."sku", c."price", c."sale_price", c."tax_class_id",
             (SELECT m."url" FROM "shp_product_media" m
               WHERE m."product_id" = c."id" AND m."type" = 'IMAGE'
               ORDER BY m."is_primary" DESC, m."position" ASC
               LIMIT 1) AS "image_url",
             (SELECT string_agg(ov."label", ' / ' ORDER BY o."position" ASC, ov."position" ASC)
                FROM "svr_variant_values" vv
                JOIN "svr_option_values" ov ON ov."id" = vv."option_value_id"
                JOIN "svr_options" o ON o."id" = ov."option_id"
               WHERE vv."variant_id" = v."id") AS "options",
             (SELECT json_agg(json_build_object('option', o."name", 'value', ov."label")
                              ORDER BY o."position" ASC, ov."position" ASC)
                FROM "svr_variant_values" vv
                JOIN "svr_option_values" ov ON ov."id" = vv."option_value_id"
                JOIN "svr_options" o ON o."id" = ov."option_id"
               WHERE vv."variant_id" = v."id") AS "option_pairs"
        FROM "svr_variants" v
        JOIN "shp_products" c ON c."id" = v."child_product_id"
       WHERE v."product_id" = ${productId}
         AND v."enabled" = true
         AND c."status" = 'ACTIVE'
       ORDER BY v."position" ASC, c."name" ASC
       LIMIT ${VARIATION_LIMIT}
    `

    return rows.map((row) => toChoice(row, settings, {
      kind: 'variation',
      options: typeof row.options === 'string' && row.options.trim() ? row.options.trim() : null,
      optionPairs: readOptionPairs(row.option_pairs),
    }))
  },

  /**
   * The chosen things as they stand now, in the order they were chosen.
   *
   * Prices are read here rather than carried from the browser on purpose: a
   * draft can sit in the list for a week, and a quotation that goes out at last
   * month's price is worse than one that goes out at none. Anything withdrawn
   * since it was picked comes back missing and is simply not printed.
   */
  async resolve(refs): Promise<ResolvedProduct[]> {
    const productIds = refs.filter((r) => r.kind === 'product').map((r) => r.id)
    const variationIds = refs.filter((r) => r.kind === 'variation').map((r) => r.id)
    if (productIds.length === 0 && variationIds.length === 0) return []

    const settings = await readSettings()
    const found = new Map<string, ProductChoice>()

    if (productIds.length > 0) {
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT p."id", p."name", p."slug", p."sku", p."price", p."sale_price", p."tax_class_id",
               (SELECT m."url" FROM "shp_product_media" m
                 WHERE m."product_id" = p."id" AND m."type" = 'IMAGE'
                 ORDER BY m."is_primary" DESC, m."position" ASC
                 LIMIT 1) AS "image_url"
          FROM "shp_products" p
         WHERE p."id" IN (${inList(productIds)})
           AND p."status" = 'ACTIVE'
           AND p."catalogue_hidden" = false
      `
      const from = await fromPrices(rows.map((r) => r.id as string), settings)
      for (const row of rows) {
        const range = from.get(row.id as string) ?? null
        const choice = toChoice(row, settings, {
          kind: 'product',
          from: range,
          variationCount: range?.count ?? 0,
        })
        found.set(`product:${choice.id}`, choice)
      }
    }

    if (variationIds.length > 0 && (await variationsAvailable())) {
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT c."id", c."name", c."slug", c."sku", c."price", c."sale_price", c."tax_class_id",
               (SELECT m."url" FROM "shp_product_media" m
                 WHERE m."product_id" = c."id" AND m."type" = 'IMAGE'
                 ORDER BY m."is_primary" DESC, m."position" ASC
                 LIMIT 1) AS "image_url",
               (SELECT string_agg(ov."label", ' / ' ORDER BY o."position" ASC, ov."position" ASC)
                  FROM "svr_variant_values" vv
                  JOIN "svr_option_values" ov ON ov."id" = vv."option_value_id"
                  JOIN "svr_options" o ON o."id" = ov."option_id"
                 WHERE vv."variant_id" = v."id") AS "options"
          FROM "svr_variants" v
          JOIN "shp_products" c ON c."id" = v."child_product_id"
         WHERE c."id" IN (${inList(variationIds)})
           AND v."enabled" = true
           AND c."status" = 'ACTIVE'
      `
      for (const row of rows) {
        const choice = toChoice(row, settings, {
          kind: 'variation',
          options: typeof row.options === 'string' && row.options.trim() ? row.options.trim() : null,
        })
        found.set(`variation:${choice.id}`, choice)
      }
    }

    const out: ResolvedProduct[] = []
    for (const ref of refs) {
      const choice = found.get(`${ref.kind}:${ref.id}`)
      if (!choice) continue
      out.push({
        choice,
        link: {
          moduleName: 'shop',
          recordType: choice.kind,
          recordId: choice.id,
          // Its own name and nothing else. The options are already in the name
          // of a variation nine times in ten, and a row reading "Task Chair -
          // Black (Black)" is a row somebody has to read twice.
          label: choice.name || choice.options || 'Product',
        },
      })
    }
    return out
  },
}
