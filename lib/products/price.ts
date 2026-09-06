// What a price says on a message, and whether "+ VAT" belongs after it.
//
// Every rule here is the shop's own, restated rather than imported: a source in
// this folder may read another module's tables and may not import its code (see
// ./types.ts). So the two can drift, and the guard against that is this file
// being tiny, pure and tested - the arithmetic is three lines, and the decision
// it exists for is one sentence:
//
//   A price is followed by "+ VAT" when the shop QUOTES ITS PRICES NET and the
//   thing being quoted is actually taxed. Neither half on its own is enough. A
//   shop showing gross prices has already included it, and a zero-rated product
//   has none to add - printing "+ VAT" on either is a lie about the money.
//
// The shop's own reasoning lives in modules/shop/lib/tax-display-shared.ts, and
// the settings are Shop settings > General (`taxMode`: what the figures in the
// editor MEAN) and Shop settings > Tax & shipping (`priceDisplayTax`: what the
// storefront PRINTS).

/** The shop's two price-display settings, as they come out of its config. */
export type PriceDisplay = {
  /** 'AS_ENTERED' keeps the storefront in step with how prices were typed. */
  mode: 'AS_ENTERED' | 'INCLUSIVE' | 'EXCLUSIVE'
  /** Whether the stored figures already carry tax - `taxMode === 'INCLUSIVE'`. */
  storedIncludesTax: boolean
  /** What the shop calls the tax - 'VAT' here, 'Sales tax' elsewhere. The
   *  shop's own invoice label, so a message and an invoice from the same site
   *  call the same thing by the same name. */
  taxLabel: string
}

/** What a shop that has said nothing does: print what is stored, say nothing
 *  about tax. Also the answer wherever the config could not be read, so a shop
 *  nobody can reach quotes no VAT rather than inventing some. */
export const PLAIN_PRICE_DISPLAY: PriceDisplay = {
  mode: 'AS_ENTERED',
  storedIncludesTax: true,
  taxLabel: 'VAT',
}

/** What a shop that has never told anybody what its tax is called calls it. The
 *  shop's own default too, so the two agree out of the box. */
export const DEFAULT_TAX_LABEL = 'VAT'

/** Whether what is being printed carries tax already. */
export function displayIncludesTax(display: PriceDisplay): boolean {
  if (display.mode === 'AS_ENTERED') return display.storedIncludesTax
  return display.mode === 'INCLUSIVE'
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/** A stored figure as it should be printed, to the penny. A shop that has left
 *  the setting alone, and anything zero-rated, is a multiply by one rather than
 *  a special case. */
export function displayAmount(amount: number, display: PriceDisplay, taxRate: number): number {
  const rate = Number.isFinite(taxRate) && taxRate > 0 ? taxRate : 0
  if (rate === 0) return amount
  const wanted = displayIncludesTax(display)
  if (wanted === display.storedIncludesTax) return amount
  return round2(wanted ? amount * (1 + rate) : amount / (1 + rate))
}

/**
 * What goes after the price, or null for nothing.
 *
 * Deliberately "+ VAT" rather than the shop's own storefront suffix, which on a
 * net-priced shop usually reads "ex. VAT". They are two different sentences for
 * two different places: on a shelf full of prices, "ex. VAT" says what the
 * figure IS; in a message quoting one price to one person, "+ VAT" says what
 * will happen to it. The name of the tax is still the shop's, so a site that
 * calls it something else is quoted in its own words rather than in ours.
 */
export function taxSuffix(display: PriceDisplay, taxRate: number): string | null {
  const rate = Number.isFinite(taxRate) && taxRate > 0 ? taxRate : 0
  if (rate === 0) return null
  if (displayIncludesTax(display)) return null
  return `+ ${display.taxLabel.trim() || DEFAULT_TAX_LABEL}`
}

/**
 * Money as this shop writes it: its own symbol, grouped thousands, two decimals.
 *
 * The locale is pinned rather than left to the runtime's, exactly as the shop
 * pins its own: a server that thinks it is in Germany would render "1.600,00"
 * into an email that quotes "1,600.00" everywhere else on the site.
 */
export function formatPrice(amount: number, symbol: string): string {
  const value = Number.isFinite(amount) ? amount : 0
  return `${symbol}${value.toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

/**
 * The figure a shopper is actually charged.
 *
 * Sale prices only undercut where the shop has that price type switched on, and
 * a sale price at or above the normal one is a typo rather than a discount -
 * both are the shop's own rules (modules/shop/lib/pricing.ts), and getting
 * either wrong would quote a customer a price the checkout then disagrees with.
 */
export function effectivePrice(
  price: number,
  salePrice: number | null,
  saleEnabled: boolean,
): number {
  if (!saleEnabled) return price
  if (salePrice === null || !Number.isFinite(salePrice)) return price
  if (salePrice < 0 || salePrice >= price) return price
  return salePrice
}
