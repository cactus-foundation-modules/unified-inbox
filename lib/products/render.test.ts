import { describe, it, expect } from 'vitest'
import { priceLine, renderProductTable, renderProductText } from './render'
import type { ProductChoice } from './types'

function product(over: Partial<ProductChoice> = {}): ProductChoice {
  return {
    moduleName: 'shop',
    kind: 'product',
    id: 'p1',
    name: 'Ergo Task Chair',
    options: null,
    optionPairs: [],
    price: '£249.00',
    priceFrom: false,
    priceSuffix: null,
    imageUrl: null,
    url: 'https://example.com/shop/products/ergo-task-chair',
    sku: 'ERG-1',
    variationCount: 0,
    ...over,
  }
}

describe('renderProductTable', () => {
  it('has no heading row - these are things being shown, not a receipt', () => {
    const html = renderProductTable([product()])
    expect(html).not.toContain('Item')
    expect(html).not.toContain('Qty')
    expect(html).not.toContain('Price')
    expect(html).not.toContain('text-transform:uppercase')
  })

  it('has no quantity column, because nothing here has been ordered', () => {
    const html = renderProductTable([product()])
    // Two cells to a row without pictures, the name and the price, inside the
    // one cell of the outer table that holds the box.
    expect(html.match(/<td/g)).toHaveLength(3)
  })

  it('carries no margin when it stands in for a block in the writing', () => {
    // A line typed straight under the block must arrive straight under it.
    expect(renderProductTable([product()], { inline: true })).toContain('margin:0;')
    expect(renderProductTable([product()])).toContain('margin:16px 0;')
  })

  it('prints nothing at all when there are no products', () => {
    expect(renderProductTable([])).toBe('')
    expect(renderProductText([])).toBe('')
  })

  it('puts "+ VAT" after a price the shop quotes net', () => {
    const html = renderProductTable([product({ priceSuffix: '+ VAT' })])
    expect(html).toContain('£249.00 + VAT')
  })

  it('says "From" where the price is the cheapest of several', () => {
    const html = renderProductTable([product({ price: '£419.00', priceFrom: true })])
    expect(html).toContain('From £419.00')
  })

  it('gives the picture column only where something has been photographed', () => {
    expect(renderProductTable([product()])).not.toContain('<img')
    const withImage = renderProductTable([product({ imageUrl: 'https://example.com/a.jpg' })])
    expect(withImage).toContain('<img')
    // An empty cell rather than none on the ones with no photograph, so the
    // names below stay in a straight line.
    const mixed = renderProductTable([
      product({ imageUrl: 'https://example.com/a.jpg' }),
      product({ id: 'p2', imageUrl: null }),
    ])
    expect(mixed.match(/<td/g)).toHaveLength(8)
  })

  it('links the name and the picture to the product page', () => {
    const html = renderProductTable([product({ imageUrl: 'https://example.com/a.jpg' })])
    expect(html.match(/<a href="https:\/\/example.com\/shop\/products\/ergo-task-chair"/g))
      .toHaveLength(2)
  })

  it('leaves the name as plain text where there is nowhere to point at', () => {
    const html = renderProductTable([product({ url: null })])
    expect(html).not.toContain('<a href')
    expect(html).toContain('Ergo Task Chair')
  })

  it('prints a variation\'s options under its name', () => {
    const html = renderProductTable([product({ kind: 'variation', options: 'Black / High back' })])
    expect(html).toContain('Black / High back')
  })

  it('escapes everything it prints, wherever it came from', () => {
    const html = renderProductTable([product({
      name: 'Chair <script>alert(1)</script>',
      options: 'Colour: "Black" & grey',
      url: 'https://example.com/a"onmouseover="alert(1)',
    })])
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&quot;Black&quot; &amp; grey')
    expect(html).not.toContain('onmouseover="alert(1)"')
  })

  it('draws each product in a rounded box of its own, stacked with a small gap', () => {
    const html = renderProductTable([product(), product({ id: 'p2' })])
    // On the table, never the row: Outlook does not draw a border on a <tr>,
    // and a radius means nothing under border-collapse:collapse.
    expect(html).not.toContain('<tr style')
    expect(html.match(/border-collapse:separate;width:100%;border:1px solid #e5e5e5;border-radius:8px;/g))
      .toHaveLength(2)
    // The gap under the first box and none under the last.
    expect(html).toContain('<td style="padding:0 0 6px;">')
    expect(html).toContain('<td style="padding:0;">')
  })
})

describe('renderProductText', () => {
  it('gives one product a line rather than flattening a table onto one', () => {
    const text = renderProductText([product(), product({ id: 'p2', name: 'Bench Desk' })])
    expect(text.split('\n\n')).toHaveLength(2)
  })

  it('says exactly what the table says about the money', () => {
    const item = product({ price: '£419.00', priceFrom: true, priceSuffix: '+ VAT' })
    expect(priceLine(item)).toBe('From £419.00 + VAT')
    expect(renderProductText([item])).toContain('From £419.00 + VAT')
  })

  it('carries the link under the line, where there is one', () => {
    expect(renderProductText([product()]))
      .toContain('https://example.com/shop/products/ergo-task-chair')
    expect(renderProductText([product({ url: null })]))
      .toBe('Ergo Task Chair - £249.00')
  })

  it('puts a variation\'s options in brackets after its name', () => {
    expect(renderProductText([product({ kind: 'variation', options: 'Black', url: null })]))
      .toBe('Ergo Task Chair (Black) - £249.00')
  })

  it('says the name alone where there is no price worth quoting', () => {
    expect(renderProductText([product({ price: null, url: null })])).toBe('Ergo Task Chair')
  })
})

describe('a delivery chosen beside a product', () => {
  const quote = { key: 'express', label: 'Express flat-pack', description: null, price: '£25.00', priceSuffix: '+ VAT' }

  it('prints the delivery on its own row, priced in the price column', () => {
    const html = renderProductTable([product({ delivery: 'express', deliveryQuote: quote })])
    // The outer row holding the box, the product and its delivery.
    expect(html.match(/<tr>/g)).toHaveLength(3)
    expect(html).toContain('Delivery: Express flat-pack')
    expect(html).toContain('£25.00 + VAT')
  })

  it('prints nothing extra where the service is no longer offered', () => {
    const html = renderProductTable([product({ delivery: 'express', deliveryQuote: null })])
    expect(html.match(/<tr>/g)).toHaveLength(2)
    expect(html).not.toContain('Delivery:')
  })

  it('puts the delivery under the product line and above its address in plain text', () => {
    expect(renderProductText([product({ deliveryQuote: quote })])).toBe(
      'Ergo Task Chair - £249.00\nDelivery: Express flat-pack - £25.00 + VAT\nhttps://example.com/shop/products/ergo-task-chair',
    )
  })

  it('names the service on the link for a channel that draws the product itself', () => {
    expect(renderProductText([product({ deliveryQuote: quote })], { markdownLinks: true })).toBe(
      '[Ergo Task Chair](https://example.com/shop/products/ergo-task-chair?delivery-service=express) - £249.00'
        + '\nDelivery: Express flat-pack - £25.00 + VAT',
    )
  })

  it('says Free for a service that costs nothing', () => {
    const free = { ...quote, price: 'Free', priceSuffix: null }
    expect(renderProductText([product({ url: null, deliveryQuote: free })])).toBe(
      'Ergo Task Chair - £249.00\nDelivery: Express flat-pack - Free',
    )
  })
})

