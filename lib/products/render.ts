import { escapeHtml } from '@/lib/email/blocks'
import { deliveryLine } from './slots'
import type { ProductChoice } from './types'

/** The query parameter a product link carries the chosen delivery service in.
 *  The storefront reads only its own option names off a product address, so
 *  this rides along untouched; Live Chat reads it to draw the delivery under
 *  the product, the way the email does. Named so no product option is likely to
 *  share it. */
export const DELIVERY_PARAM = 'delivery-service'

// The products on a message, as the message prints them.
//
// Deliberately the same object a customer already knows from their order
// confirmation - a photograph, the name, the price - with two differences, both
// asked for and both worth writing down:
//
//   NO HEADING ROW. An order confirmation is a document and wants columns
//   labelled; two chairs mentioned in a reply are a sentence with pictures, and
//   "Item / Price" over the top of them reads as a receipt for something
//   nobody has bought.
//
//   NO QUANTITY. Nothing here has been ordered. A number beside a product
//   somebody is merely being shown is a number they have to work out the
//   meaning of.
//
// The tax suffix is the shop's own answer, worked out in ./price.ts: a price is
// followed by "+ VAT" only where the shop quotes net prices AND the thing is
// actually taxed.
//
// Email is not the web, so: tables rather than flex, every rule inline, no CSS
// custom properties and no variables, and fixed pixel widths. The same
// constraints core's own email blocks are written under, and shop's order lines
// beside them - which is why this looks like a copy of that file and is one, in
// the small way a module is allowed to be: a source in this folder may read
// another module's tables and may never import its code.

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
const TEXT = '#333333'
const MUTED = '#666666'
const RULE = '#e5e5e5'
const THUMB = 64

/** The name, linked to the product where there is a link to give. Underlined
 *  rather than recoloured: the site's palette is not available in an email, and
 *  a hardcoded brand blue clashes with every signature that is not blue. */
function linked(html: string, url: string | null): string {
  const href = (url ?? '').trim()
  if (!href) return html
  return `<a href="${escapeHtml(href)}" style="color:${TEXT};text-decoration:underline;">${html}</a>`
}

function thumbCell(product: ProductChoice, cell: string): string {
  if (!product.imageUrl) {
    // An empty cell rather than no cell, so a product with no photograph does
    // not shunt its name under the column of pictures above it.
    return `<td width="${THUMB}" style="${cell}width:${THUMB}px;">&nbsp;</td>`
  }
  // alt is deliberately empty: the name is in the cell beside it, and a client
  // with pictures switched off would otherwise print it twice.
  const img =
    `<img src="${escapeHtml(product.imageUrl)}" width="${THUMB}" height="${THUMB}" alt="" ` +
    `style="display:block;width:${THUMB}px;height:${THUMB}px;border:1px solid ${RULE};` +
    `border-radius:4px;object-fit:cover;" />`
  // The photograph goes where the name goes: it is the thing people click in an
  // email, and a picture that does nothing beside a name that is a link reads
  // as broken.
  return `<td width="${THUMB}" style="${cell}width:${THUMB}px;">${linked(img, product.url)}</td>`
}

/** The price as one string: 'From £419.00 + VAT', '£249.00', or '' where there
 *  is no price worth quoting. Exported because the plain-text half says exactly
 *  the same thing and the two must not drift. */
export function priceLine(product: ProductChoice): string {
  if (!product.price) return ''
  const figure = product.priceFrom ? `From ${product.price}` : product.price
  return product.priceSuffix ? `${figure} ${product.priceSuffix}` : figure
}

/**
 * The products as an email-safe table.
 *
 * The picture column earns its place: it appears only when at least one product
 * has a photograph, so a list of things nobody has photographed is a plain two
 * column list of names and prices rather than a column of empty squares.
 *
 * Returns '' for nothing at all, so a message carrying no products carries no
 * markup either.
 */
export function renderProductTable(
  products: readonly ProductChoice[],
  /** `inline`: the table stands where a block sat in the writing box, so it
   *  carries no margin of its own. The box draws that block with a border and a
   *  hair of space round it, and a line typed straight under it reads as
   *  touching it; a 16px margin on top of the cells' own padding arrived as a
   *  blank line nobody had typed. The run-on list under a message keeps its
   *  margin, since that one is standing apart from the words on purpose. */
  options: { inline?: boolean } = {},
): string {
  if (products.length === 0) return ''
  const margin = options.inline ? '0' : '16px 0'
  const withImages = products.some((p) => p.imageUrl)

  const base = `font-family:${FONT};font-size:15px;line-height:1.45;color:${TEXT};`

  // Each product in a box of its own, stacked one under the next with a hair of
  // space between - the same object the writing box drew while it was being
  // written. The rounded corners are what every client but desktop Outlook
  // draws; Outlook squares them off and keeps the border, which is the right way
  // round for it to fail.
  //
  // The box's border goes on a <table> with border-collapse:separate, not on the
  // cells or a <tr>: a border on <tr> is one of the things Outlook does not
  // draw, and border-radius does nothing at all under border-collapse:collapse.
  const boxes = products.map((product) => {
    const quote = product.deliveryQuote ?? null
    // The box carries the padding round the edge; the cells carry the space
    // between them. A product with a delivery under it keeps the two lines
    // close, so they read as one item.
    const cell = `${base}padding:12px 0 ${quote ? '4px' : '12px'} 12px;vertical-align:top;`
    const options = product.options
      ? `<br /><span style="color:${MUTED};font-size:13px;">${escapeHtml(product.options)}</span>`
      : ''
    const price = priceLine(product)

    const productRow =
      '<tr>' +
      (withImages ? thumbCell(product, cell) : '') +
      `<td style="${cell}">` +
      `<strong>${linked(escapeHtml(product.name), product.url)}</strong>` +
      options +
      '</td>' +
      `<td align="right" style="${cell}padding-right:12px;white-space:nowrap;">${escapeHtml(price)}</td>` +
      '</tr>'

    // The delivery chosen for it, on a line of its own under the name and
    // priced in the same column, so a customer adding it up adds two figures
    // that sit one above the other. Muted, because the product is the subject.
    const dcell = `${base}padding:0 0 12px 12px;vertical-align:top;color:${MUTED};font-size:14px;`
    const dprice = quote ? (quote.priceSuffix ? `${quote.price} ${quote.priceSuffix}` : quote.price) : ''
    const deliveryRow = quote
      ? '<tr>' +
        (withImages ? `<td width="${THUMB}" style="${dcell}width:${THUMB}px;">&nbsp;</td>` : '') +
        `<td style="${dcell}">Delivery: ${escapeHtml(quote.label)}</td>` +
        `<td align="right" style="${dcell}padding-right:12px;white-space:nowrap;">${escapeHtml(dprice)}</td>` +
        '</tr>'
      : ''

    return (
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" ' +
      `style="border-collapse:separate;width:100%;border:1px solid ${RULE};border-radius:8px;">` +
      productRow +
      deliveryRow +
      '</table>'
    )
  })

  // One row per box in an outer table, the gap as padding under every box but
  // the last: a margin between tables is another thing Outlook ignores.
  const GAP = 6
  return (
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" ' +
    `style="border-collapse:collapse;width:100%;margin:${margin};">` +
    boxes
      .map((box, index) =>
        `<tr><td style="padding:${index === boxes.length - 1 ? '0' : `0 0 ${GAP}px`};">${box}</td></tr>`)
      .join('') +
    '</table>'
  )
}

/**
 * The same list for the plain-text half of the message.
 *
 * Not flattened out of the markup above: a table flattens into one long line in
 * every text client there is, and the text part of an email is what a screen
 * reader and a phone on a bad signal actually get. One product to a line, the
 * options in brackets, the price after a dash, and the link under it where
 * there is one.
 */
export function renderProductText(
  products: readonly ProductChoice[],
  /** The channel shows `[words](address)` as a link: the name becomes the link
   *  and the bare address is not printed beside it. */
  options: { markdownLinks?: boolean } = {},
): string {
  if (products.length === 0) return ''
  return products
    .map((product) => {
      const head = [
        product.name,
        product.options ? `(${product.options})` : '',
      ].filter(Boolean).join(' ')
      const price = priceLine(product)
      const delivery = product.deliveryQuote ? `\n${deliveryLine(product.deliveryQuote)}` : ''
      if (options.markdownLinks && product.url) {
        const label = head.replace(/[[\]]/g, '')
        const url = withDeliveryParam(product.url, product.deliveryQuote?.key ?? null)
        return (price ? `[${label}](${url}) - ${price}` : `[${label}](${url})`) + delivery
      }
      // The delivery belongs to the product, so it sits under its line and
      // above the address, which is the thing a reader skips.
      const line = (price ? `${head} - ${price}` : head) + delivery
      return product.url ? `${line}\n${product.url}` : line
    })
    .join('\n\n')
}

/** A product address with the chosen delivery service on it, for a channel that
 *  draws the product itself (Live Chat) and so can draw its delivery too. The
 *  address unchanged where nothing was chosen or it will not parse. */
export function withDeliveryParam(url: string, key: string | null): string {
  if (!key) return url
  try {
    const parsed = new URL(url)
    parsed.searchParams.set(DELIVERY_PARAM, key)
    return parsed.toString()
  } catch {
    return url
  }
}
