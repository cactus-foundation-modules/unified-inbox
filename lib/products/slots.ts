import { BLOCK_ACT_CLASS, BLOCK_CLASS, BLOCK_OFF_CLASS } from '../richtext-blocks'
import type { DeliveryQuote, ProductChoice, ProductRef } from './types'

// A product where somebody put it, rather than in a heap at the bottom.
//
// The catalogue used to go on a message as a LIST beside the writing: pick
// three chairs, and the three chairs printed under everything typed, in the
// order they were picked, whatever the message actually said. That is the wrong
// way round for the commonest thing anybody writes - "this one is the cheapest,
// this one is the one I would buy, and this third one is what you asked for" -
// because the words and the things they are about end up in different halves of
// the email.
//
// So a product is now a SLOT in the writing itself. Picking one drops a block
// into the box where the caret is, the block shows what will print there, and
// the words carry on underneath it. Nothing about what leaves the building
// changed: the slot is a marker, and the real table is rendered on the server at
// the moment Send is pressed, out of the shop's own tables. A price that moves
// between writing and sending still moves in the message.
//
// WHY THE REFERENCE LIVES IN A CLASS. The marker has to survive core's email
// sanitiser, which is the last gate the typed half goes through and which drops
// every attribute not on its allow-list - `data-` attributes included. `class`
// is on that list, and a class token is a string with no spaces in it, which is
// exactly what a reference is. So the slot wears its own reference:
//
//   <div class="uin-product-slot uin-ps--shop--product--abc123" …>
//
// Module names are kebab-case and never contain a double hyphen, and the kind is
// one of two known words, so splitting on '--' puts the product's own id back
// together again however many hyphens it has in it.
//
// NOTHING HERE TOUCHES THE DATABASE OR THE DOM. It is string work on both sides
// of the wire: the composer builds slots in the browser, the send path takes
// them apart on the server, and one file saying what the shape is means the two
// cannot drift.

/** On every slot, so the send path can find them without knowing what is in
 *  them. */
export const SLOT_CLASS = 'uin-product-slot'

const REF_PREFIX = 'uin-ps--'

/** How a product is keyed everywhere in this module: the picker, the composer's
 *  own list and the send path all compare on this and nothing else. */
export function refKey(ref: ProductRef | ProductChoice): string {
  return `${ref.moduleName}:${ref.kind}:${ref.id}${refSuffix(ref)}`
}

/** What follows the id in both a key and a class token: the picks after a
 *  '~', then the delivery service after an '@'. Neither character can appear
 *  in either half, so the two split apart again unambiguously. */
function refSuffix(ref: ProductRef | ProductChoice): string {
  return `${ref.picks ? `~${ref.picks}` : ''}${ref.delivery ? `@${ref.delivery}` : ''}`
}

/** What a picks string may look like: `key.slug` pairs joined by '+', and
 *  nothing a class token or a query string would need escaping for. */
export const PICKS_PATTERN = /^[a-z0-9-]+\.[a-z0-9-]+(\+[a-z0-9-]+\.[a-z0-9-]+)*$/

/** What a delivery service's key may look like to ride on a slot: letters,
 *  digits, hyphens and underscores. A service whose key is anything else is
 *  simply not offered - see lib/products/delivery.ts, which says the same. */
export const DELIVERY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/

/** Written in a template rather than imported: the one escaper this module could
 *  borrow lives in core's email blocks, and that file pulls the Puck helpers in
 *  behind it - which is a server graph, and this file is built in a browser. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** The class token that carries the reference. */
export function refClass(ref: ProductRef | ProductChoice): string {
  return `${REF_PREFIX}${ref.moduleName}--${ref.kind}--${ref.id}${refSuffix(ref)}`
}

/** The reference back out of one class token, or null for a token that is not
 *  one. Anything malformed is not a slot rather than an error: a body that has
 *  been through somebody's clipboard is not a contract. */
export function parseRefClass(token: string): ProductRef | null {
  if (!token.startsWith(REF_PREFIX)) return null
  const parts = token.slice(REF_PREFIX.length).split('--')
  if (parts.length < 3) return null
  const [moduleName, kind, ...rest] = parts
  const whole = rest.join('--')
  const at = whole.indexOf('@')
  const joined = at === -1 ? whole : whole.slice(0, at)
  const delivery = at === -1 ? '' : whole.slice(at + 1)
  const tilde = joined.indexOf('~')
  const id = tilde === -1 ? joined : joined.slice(0, tilde)
  const picks = tilde === -1 ? '' : joined.slice(tilde + 1)
  if (!moduleName || !id) return null
  if (kind !== 'product' && kind !== 'variation') return null
  if (at !== -1 && !DELIVERY_KEY_PATTERN.test(delivery)) return null
  const ref: ProductRef = { moduleName, kind, id }
  if (delivery) ref.delivery = delivery
  if (!picks) return ref
  // Picks only narrow a listing, and only in the shape we write them.
  return kind === 'product' && PICKS_PATTERN.test(picks) ? { ...ref, picks } : null
}

/** A reference with a different delivery service on it, or none. The class
 *  token the composer swaps onto a slot when somebody picks one. */
export function withDelivery<T extends ProductRef | ProductChoice>(ref: T, delivery: string | null): T {
  const next = { ...ref }
  if (delivery && DELIVERY_KEY_PATTERN.test(delivery)) next.delivery = delivery
  else delete next.delivery
  return next
}

/** The delivery as one line: 'Delivery: Express flat-pack - £25.00 + VAT', or
 *  'Delivery: Standard - Free'. The same sentence lib/products/render.ts prints
 *  into the email and the plain-text half, and the one Live Chat looks for to
 *  tidy away under its own card. */
export function deliveryLine(quote: DeliveryQuote): string {
  const price = quote.priceSuffix ? `${quote.price} ${quote.priceSuffix}` : quote.price
  return `Delivery: ${quote.label} - ${price}`
}

/** On the delivery line inside a slot, so the composer can rewrite it in place. */
export const SLOT_DELIVERY_CLASS = 'uin-ps-dl'

/** On the "Add delivery" control inside a slot. Generic to the writing box (see
 *  lib/richtext-blocks.ts, BLOCK_ACT_CLASS), named here for the composer. */
export const SLOT_DELIVERY_ACT = 'delivery'

/**
 * The inside of a slot's delivery line: what is quoted, if anything, and the
 * control that adds or changes it. Spans only - see slotHtml for why there is
 * never a <div> inside a slot.
 *
 * The control is for whoever is writing and for nobody else: the slot is
 * thrown away and replaced by the real table at the moment Send is pressed, so
 * nothing in here ever reaches a customer.
 */
export function slotDeliveryInnerHtml(quote: DeliveryQuote | null | undefined): string {
  const words = quote
    ? `<span class="uin-ps-dl-words">${escapeHtml(deliveryLine(quote))}</span>`
    : ''
  return (
    words +
    `<span class="${BLOCK_ACT_CLASS} uin-ps-dl-act" data-act="${SLOT_DELIVERY_ACT}" role="button" tabindex="-1">` +
    (quote ? 'Change delivery' : 'Add delivery') +
    '</span>'
  )
}

/** The price as one line: 'From £419.00 + VAT'. The same sentence
 *  lib/products/render.ts prints into the email, so the block in the box and the
 *  thing that arrives cannot read differently. */
export function priceLine(product: ProductChoice): string {
  if (!product.price) return ''
  const figure = product.priceFrom ? `From ${product.price}` : product.price
  return product.priceSuffix ? `${figure} ${product.priceSuffix}` : figure
}

/**
 * One product as it sits in the writing box.
 *
 * Painted on white with the email's own colours rather than the admin's tokens,
 * and deliberately - the same decision the frame round a received message makes.
 * This is a picture of what leaves the building, and a preview that quietly
 * repainted itself for dark mode would be a preview of something nobody is going
 * to get. Only the cross is ours, so only the cross follows the theme.
 *
 * `contenteditable="false"` makes it one object: the caret steps over it, a
 * backspace takes the whole thing, and nobody ends up editing half a price.
 *
 * NOT a <div> inside a <div>. The send path finds a slot by matching up to its
 * first closing tag, which is exact only while nothing here nests one - so the
 * inside is images and spans, and it stays that way.
 */
export function slotHtml(product: ProductChoice): string {
  const price = priceLine(product)
  const thumb = product.imageUrl
    ? `<img class="uin-ps-thumb" src="${escapeHtml(product.imageUrl)}" alt="" width="64" height="64" />`
    : ''
  const options = product.options
    ? `<span class="uin-ps-opts">${escapeHtml(product.options)}</span>`
    : ''
  // Offered where the site has delivery services to offer, and shown wherever
  // one has been chosen - a draft reopened on a site that has since lost its
  // delivery module still says what it was going to quote.
  const delivery = product.canQuoteDelivery || product.deliveryQuote
    ? `<span class="${SLOT_DELIVERY_CLASS}">${slotDeliveryInnerHtml(product.deliveryQuote)}</span>`
    : ''
  return (
    `<div class="${SLOT_CLASS} ${BLOCK_CLASS} ${refClass(product)}" contenteditable="false">` +
    thumb +
    `<span class="uin-ps-words"><strong>${escapeHtml(product.name)}</strong>${options}${delivery}</span>` +
    (price ? `<span class="uin-ps-price">${escapeHtml(price)}</span>` : '') +
    `<span class="${BLOCK_OFF_CLASS}" role="button" tabindex="-1" ` +
    `title="Take it off this message" aria-label="Take ${escapeHtml(product.name)} off this message">` +
    '&#10005;</span>' +
    '</div>'
  )
}

// One slot, however its attributes ended up ordered - the browser writes them in
// one order and the sanitiser re-serialises them in another, and neither is
// worth depending on.
const SLOT_RE = new RegExp(
  `<div\\b[^>]*\\bclass="[^"]*\\b${SLOT_CLASS}\\b[^"]*"[^>]*>[\\s\\S]*?<\\/div>`,
  'gi',
)

function refIn(openingTag: string): ProductRef | null {
  const classes = /\bclass="([^"]*)"/i.exec(openingTag)?.[1] ?? ''
  for (const token of classes.split(/\s+/)) {
    const ref = parseRefClass(token)
    if (ref) return ref
  }
  return null
}

/** Every product in the body, in the order it is read in. A slot whose class
 *  says nothing recognisable is skipped, and the same product twice is two
 *  entries - quoting one chair twice in one message is a thing people do. */
export function slotRefs(html: string): ProductRef[] {
  const found: ProductRef[] = []
  for (const match of html.matchAll(SLOT_RE)) {
    const ref = refIn(match[0])
    if (ref) found.push(ref)
  }
  return found
}

/**
 * Every slot swapped for whatever `render` gives back for it.
 *
 * Returning '' takes the slot out altogether, which is what a product that has
 * been withdrawn since it was picked wants: the line should not go out, and
 * refusing to send the whole message over it would be the wrong half of the
 * bargain. A slot with no readable reference goes the same way, silently -
 * there is nothing to print and a stray empty box in an email helps nobody.
 */
export function replaceSlots(html: string, render: (ref: ProductRef) => string): string {
  return html.replace(SLOT_RE, (whole) => {
    const ref = refIn(whole)
    return ref ? render(ref) : ''
  })
}

/** The body with the slots taken out and nothing put back. */
export function stripSlots(html: string): string {
  return replaceSlots(html, () => '')
}

/** Slots for a list of products, run onto the end of a body that has none.
 *  A draft written before the catalogue went into the writing box carries its
 *  products beside the words rather than in them; this is what puts them where
 *  they belong the first time that draft is opened again. */
export function appendSlots(html: string, products: readonly ProductChoice[]): string {
  if (products.length === 0) return html
  return html + products.map(slotHtml).join('')
}

/** What a slot becomes while a body is being flattened to words. Nothing
 *  anybody would type, and the substitution below only trusts an index it
 *  actually handed out. */
const MARK = '[[uin-product-slot:'
const MARK_RE = new RegExp(`${MARK.replace(/[[\]]/g, '\\$&')}(\\d+)\\]\\]`, 'g')

/**
 * The plain-text half of a body that has products in it.
 *
 * A product table flattened by a general-purpose html-to-text pass is one long
 * line, and the text part of an email is what a screen reader and a phone on a
 * bad signal actually get - so each slot becomes a token in a paragraph of its
 * own, the body is flattened, and the tokens are swapped for the product's own
 * text afterwards.
 *
 * `flatten` is passed in rather than imported: this file is built into the
 * browser bundle and the module's own flattener sits behind core's sanitiser,
 * which is jsdom and has no business being there.
 */
export function flattenWithProducts(
  html: string,
  textFor: (ref: ProductRef) => string | null,
  flatten: (html: string) => string,
): string {
  const marks: string[] = []
  const marked = replaceSlots(html, (ref) => {
    const text = textFor(ref)
    if (text === null) return ''
    marks.push(text)
    return `<p>${MARK}${marks.length - 1}]]</p>`
  })
  return flatten(marked).replace(MARK_RE, (whole, index) => marks[Number(index)] ?? whole)
}
