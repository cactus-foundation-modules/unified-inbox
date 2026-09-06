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
    // Two cells to a row without pictures: the name and the price.
    expect(html.match(/<td/g)).toHaveLength(2)
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
    expect(mixed.match(/<td/g)).toHaveLength(6)
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

  it('draws the rule on the cells rather than the row, because Outlook', () => {
    const html = renderProductTable([product(), product({ id: 'p2' })])
    expect(html).not.toContain('<tr style')
    expect(html).toContain('border-bottom:1px solid')
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
