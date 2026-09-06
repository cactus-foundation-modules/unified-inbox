// Putting the site's own products on a message.
//
// The same division of labour the context rail uses (see lib/adapters/types.ts)
// and for the same three reasons, none of them negotiable:
//
//   1. READS ONLY. A source answers "what do you sell" and nothing else. It
//      never writes, never migrates, never renders.
//   2. RAW SQL ONLY. No import of another module's code, ever. An import drags
//      that module's dependencies into our graph and stops the build the day it
//      is uninstalled; a query merely returns nothing.
//   3. GATED BEFORE IT COSTS ANYTHING. `moduleName`, `tables` and `permission`
//      are declared rather than discovered inside a query, so a site with no
//      shop spends one cheap check finding that out.
//
// Three things can go on a message and the difference matters to the person
// reading it: a plain product, a listing that HAS variations (quoted from its
// cheapest, linking to the page where the choice is made), and one exact
// variation. The first two are the same kind - a listing - told apart by
// whether anything hangs off it; the third is its own kind because it is a
// different record.

/** What the browser hands back when somebody has chosen something. Deliberately
 *  a reference and never a price or a name: the message is built on the server
 *  from what the shop says TODAY, so nothing typed into a request can put words
 *  in the site's mouth, and a price that moved while the draft sat in the list
 *  cannot go out stale. */
export type ProductRef = {
  /** The module that sells it, as it appears in the module list. */
  moduleName: string
  kind: ProductKind
  id: string
}

export type ProductKind = 'product' | 'variation'

/** One thing on offer, as the picker draws it and as the email prints it. */
export type ProductChoice = {
  moduleName: string
  kind: ProductKind
  id: string
  /** What it is called, exactly as the shop calls it. */
  name: string
  /** The options that make this variation - 'Black / High back' - or null on a
   *  listing, which has no single answer to that question. */
  options: string | null
  /** The same answer taken apart: which option, and which value of it. Empty on
   *  anything that is not a variation.
   *
   *  The joined string above is what a person reads and what the email prints;
   *  this is what the picker narrows a long list by, and the two cannot be
   *  derived from one another - 'Black / High back' does not say which half is
   *  the colour. A range of ninety variations is a range nobody scrolls, and
   *  "the black one with arms" is how everybody asks for one. */
  optionPairs: { option: string; value: string }[]
  /** Formatted and ready to print: '£249.00'. Null where there is no price
   *  worth quoting. Never carries the tax suffix - that is beside it, because
   *  the two are styled differently. */
  price: string | null
  /** True where the price is the cheapest of several rather than THE price, so
   *  whoever prints it can say "From" in front of it. */
  priceFrom: boolean
  /** '+ VAT', printed after the price where the shop quotes net prices and this
   *  one is taxed. Null where there is nothing to say - a tax-free product, or
   *  a shop whose prices already carry the tax. */
  priceSuffix: string | null
  /** Absolute, or null where there is no picture or nothing to resolve it
   *  against. An inbox has no origin, so a site-relative src is a broken image
   *  in every mail client there is. */
  imageUrl: string | null
  /** Absolute link to its own page, or null where there is nothing safe to
   *  point at. */
  url: string | null
  /** Its code, for telling two similar-looking listings apart in the picker.
   *  Never printed in the email - a customer did not ask for our filing. */
  sku: string | null
  /** How many variations hang off this listing. 0 on a plain product and on a
   *  variation itself, which is the leaf. */
  variationCount: number
}

/** One product as it is attached to the conversation once the message has gone.
 *  The same shape the context rail's adapters use for a record, because it ends
 *  up in the same row on the same screen. */
export type ProductLink = {
  moduleName: string
  /** 'product' | 'variation' - what lib/record-links.ts turns into an address. */
  recordType: ProductKind
  recordId: string
  /** What the link says on the screen. */
  label: string
}

/** A chosen product, as the send path needs it: the line to print and the link
 *  to leave behind. One resolution answers both, because they come out of the
 *  same query and asking twice would be two. */
export type ResolvedProduct = {
  choice: ProductChoice
  link: ProductLink
}

/** How many products one message may carry. Generous enough for a quotation
 *  built out of a catalogue, short enough that nobody posts a shop. */
export const MAX_PRODUCTS_PER_MESSAGE = 20

/** How many the picker offers at once. Long enough to hold what somebody
 *  plausibly meant, short enough to read without scrolling for a minute. */
export const PRODUCT_SEARCH_LIMIT = 12

/** How many variations one listing may offer for picking.
 *
 *  It was 200, on the reasoning that a range with more than that is a range
 *  nobody scrolls. True, and beside the point once the list can be narrowed by
 *  its own options: the menus are built out of the variations that came back, so
 *  a cut-off range offers menus with values missing from them, and picking a
 *  width that exists finds nothing. Ranges of five and six hundred are ordinary
 *  in furniture - a desk in eight widths, six storage options, six finishes and
 *  three leg colours is 864 by itself - so the ceiling is set above the real
 *  ones rather than at a tidy round number below them. */
export const VARIATION_LIMIT = 1000

export type ProductSource = {
  /** The module this reads, exactly as it appears in the module list. */
  moduleName: string
  /** What the viewer must hold before anything at all is fetched. */
  permission: string
  /** Every table the queries below touch. All must exist or none of them runs. */
  tables: string[]
  /** What somebody could mean. An empty term is a browse rather than a search. */
  search(term: string, limit: number): Promise<ProductChoice[]>
  /** The variations of one listing, for picking one exactly. */
  variations(productId: string): Promise<ProductChoice[]>
  /**
   * The chosen things, as they stand right now.
   *
   * Anything that has been deleted or hidden since it was picked simply comes
   * back missing rather than as an error: a product withdrawn between writing
   * the message and sending it is a line that should not go out, and refusing
   * to send the whole message over it would be the wrong half of the bargain.
   */
  resolve(refs: readonly ProductRef[]): Promise<ResolvedProduct[]>
}
