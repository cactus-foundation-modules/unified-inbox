import { describe, expect, it } from 'vitest'
import { sanitizeEmailHtml } from '@/lib/sanitize'
import {
  appendSlots,
  flattenWithProducts,
  parseRefClass,
  refClass,
  refKey,
  replaceSlots,
  slotHtml,
  slotRefs,
  stripSlots,
  withDelivery,
} from './slots'
import type { ProductChoice, ProductRef } from './types'

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
    priceSuffix: '+ VAT',
    imageUrl: 'https://example.com/a.jpg',
    url: 'https://example.com/ergo',
    sku: 'ERG-1',
    variationCount: 0,
    ...over,
  }
}

describe('the reference a slot wears', () => {
  it('goes out and comes back the same', () => {
    const ref = { moduleName: 'shop', kind: 'variation' as const, id: 'v9' }
    expect(parseRefClass(refClass(ref))).toEqual(ref)
  })

  it('survives an id with hyphens in it, which every cuid has', () => {
    const ref = { moduleName: 'shop', kind: 'product' as const, id: 'ab-cd--ef-gh' }
    expect(parseRefClass(refClass(ref))).toEqual(ref)
  })

  it('is nothing at all for a class token that is not one', () => {
    expect(parseRefClass('uin-ps-thumb')).toBeNull()
    expect(parseRefClass('uin-ps--shop--nonsense--p1')).toBeNull()
    expect(parseRefClass('uin-ps--shop--product')).toBeNull()
  })
})

describe('slots in a body', () => {
  it('finds them in the order they are read in', () => {
    const body =
      `<p>This one:</p>${slotHtml(product())}` +
      `<p>and this one:</p>${slotHtml(product({ id: 'p2', kind: 'variation' }))}`
    expect(slotRefs(body).map(refKey)).toEqual(['shop:product:p1', 'shop:variation:p2'])
  })

  it('counts the same product twice when it is quoted twice', () => {
    const body = slotHtml(product()) + slotHtml(product())
    expect(slotRefs(body)).toHaveLength(2)
  })

  it('takes the whole block out, preview and all', () => {
    const body = `<p>Before</p>${slotHtml(product())}<p>After</p>`
    expect(stripSlots(body)).toBe('<p>Before</p><p>After</p>')
  })

  it('swaps each one for what it is given', () => {
    const body = slotHtml(product()) + slotHtml(product({ id: 'p2' }))
    expect(replaceSlots(body, (ref) => `[${ref.id}]`)).toBe('[p1][p2]')
  })

  it('finds nothing in a body that has none', () => {
    expect(slotRefs('<p>Nothing here.</p>')).toEqual([])
  })
})

describe('the sanitiser', () => {
  // The whole marker scheme rests on this: `class` is on core's email allow-list
  // and `data-` attributes are not, which is why the reference travels in a
  // class token. If this ever fails, every product on every message stops
  // arriving - silently, because a stripped slot looks exactly like a message
  // nobody put a product on.
  it('leaves a slot findable on the far side of it', () => {
    const clean = sanitizeEmailHtml(`<p>Here you go.</p>${slotHtml(product())}`)
    expect(slotRefs(clean).map(refKey)).toEqual(['shop:product:p1'])
  })

  it('leaves one findable when the product has no picture and no price', () => {
    const bare = product({ imageUrl: null, price: null, priceSuffix: null })
    expect(slotRefs(sanitizeEmailHtml(slotHtml(bare))).map(refKey)).toEqual(['shop:product:p1'])
  })
})

describe('flattening a body that has products in it', () => {
  const flatten = (html: string) => html.replace(/<\/p>/g, '\n').replace(/<[^>]+>/g, '').trim()

  it('puts each product where its slot was', () => {
    const body = `<p>First:</p>${slotHtml(product())}<p>Then:</p>${slotHtml(product({ id: 'p2' }))}`
    const out = flattenWithProducts(body, (ref) => `<<${ref.id}>>`, flatten)
    expect(out.indexOf('First')).toBeLessThan(out.indexOf('<<p1>>'))
    expect(out.indexOf('<<p1>>')).toBeLessThan(out.indexOf('Then'))
    expect(out.indexOf('Then')).toBeLessThan(out.indexOf('<<p2>>'))
  })

  it('drops a slot nobody could answer for rather than leaving its preview behind', () => {
    const out = flattenWithProducts(`<p>Here.</p>${slotHtml(product())}`, () => null, flatten)
    expect(out).toBe('Here.')
  })
})

describe('a draft written before the catalogue went into the box', () => {
  it('gets its products run onto the end', () => {
    const out = appendSlots('<p>As discussed.</p>', [product(), product({ id: 'p2' })])
    expect(slotRefs(out).map(refKey)).toEqual(['shop:product:p1', 'shop:product:p2'])
    expect(out.indexOf('As discussed')).toBeLessThan(out.indexOf('uin-product-slot'))
  })

  it('is left alone when there is nothing on it', () => {
    expect(appendSlots('<p>As discussed.</p>', [])).toBe('<p>As discussed.</p>')
  })
})

describe('what a slot shows', () => {
  it('says the same price the email will', () => {
    expect(slotHtml(product({ price: '£419.00', priceFrom: true })))
      .toContain('From £419.00 + VAT')
  })

  it('escapes a name rather than letting it write markup', () => {
    const html = slotHtml(product({ name: '<script>alert(1)</script>' }))
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('has no nested block in it, which is what makes one findable', () => {
    // The send path matches a slot up to its FIRST closing tag. A <div> inside
    // one would end the match early and leave half a preview in the email.
    expect(slotHtml(product()).match(/<div/g)).toHaveLength(1)
  })
})

describe('a delivery service on a slot', () => {
  it('rides on the class token and comes back off it', () => {
    const ref = { moduleName: 'shop', kind: 'product' as const, id: 'p1', delivery: 'express-flat-pack' }
    expect(refClass(ref)).toBe('uin-ps--shop--product--p1@express-flat-pack')
    expect(parseRefClass(refClass(ref))).toEqual(ref)
  })

  it('sits after the picks, and both come back', () => {
    const ref = { moduleName: 'shop', kind: 'product' as const, id: 'p1', picks: 'finish.grey-oak', delivery: 'standard' }
    expect(parseRefClass(refClass(ref))).toEqual(ref)
  })

  it('keys a product with a delivery apart from the same product without one', () => {
    expect(refKey(product())).not.toBe(refKey(product({ delivery: 'standard' })))
  })

  it('refuses a key it could not carry safely', () => {
    expect(parseRefClass('uin-ps--shop--product--p1@')).toBeNull()
    expect(parseRefClass('uin-ps--shop--product--p1@no.dots')).toBeNull()
  })

  it('is swapped and taken off by withDelivery', () => {
    const ref: ProductRef = { moduleName: 'shop', kind: 'variation', id: 'v1' }
    expect(withDelivery(ref, 'express').delivery).toBe('express')
    expect(withDelivery({ ...ref, delivery: 'express' }, null)).toEqual(ref)
  })

  it('offers Add delivery only where the site can quote one', () => {
    expect(slotHtml(product())).not.toContain('Add delivery')
    expect(slotHtml(product({ canQuoteDelivery: true }))).toContain('Add delivery')
  })

  it('shows what will print, keeps no div inside, and survives the sanitiser', () => {
    const quote = { key: 'standard', label: 'Standard', description: null, price: 'Free', priceSuffix: null }
    const html = slotHtml(product({ canQuoteDelivery: true, delivery: 'standard', deliveryQuote: quote }))
    expect(html).toContain('Delivery: Standard - Free')
    expect(html).toContain('Change delivery')
    expect(html.match(/<div/g)).toHaveLength(1)
    expect(slotRefs(sanitizeEmailHtml(html))).toEqual([{ moduleName: 'shop', kind: 'product', id: 'p1', delivery: 'standard' }])
  })
})

