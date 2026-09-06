import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TAX_LABEL,
  PLAIN_PRICE_DISPLAY,
  displayAmount,
  displayIncludesTax,
  effectivePrice,
  formatPrice,
  taxSuffix,
  type PriceDisplay,
} from './price'

// The whole point of this file is one sentence: "+ VAT" appears where the shop
// quotes NET prices and the thing is actually taxed. Both halves are tested
// both ways round, because getting either of them wrong misquotes a customer by
// twenty per cent.

const netShop: PriceDisplay = { mode: 'AS_ENTERED', storedIncludesTax: false, taxLabel: 'VAT' }
const grossShop: PriceDisplay = { mode: 'AS_ENTERED', storedIncludesTax: true, taxLabel: 'VAT' }
const VAT = 0.2

describe('taxSuffix', () => {
  it('says "+ VAT" on a taxed product in a shop that quotes net prices', () => {
    expect(taxSuffix(netShop, VAT)).toBe('+ VAT')
  })

  it('says nothing on a zero-rated product, however the shop quotes', () => {
    expect(taxSuffix(netShop, 0)).toBeNull()
    expect(taxSuffix(grossShop, 0)).toBeNull()
  })

  it('says nothing where the price already carries the tax', () => {
    expect(taxSuffix(grossShop, VAT)).toBeNull()
  })

  it('follows what the storefront PRINTS rather than how prices were typed', () => {
    // Prices typed with the tax in them, storefront told to show them without.
    const shown: PriceDisplay = { mode: 'EXCLUSIVE', storedIncludesTax: true, taxLabel: 'VAT' }
    expect(taxSuffix(shown, VAT)).toBe('+ VAT')
    // And the other way round: typed net, shown gross, so nothing to add.
    const gross: PriceDisplay = { mode: 'INCLUSIVE', storedIncludesTax: false, taxLabel: 'VAT' }
    expect(taxSuffix(gross, VAT)).toBeNull()
  })

  it('calls the tax whatever the shop calls it', () => {
    expect(taxSuffix({ ...netShop, taxLabel: 'Sales tax' }, VAT)).toBe('+ Sales tax')
    // Whitespace is not a name.
    expect(taxSuffix({ ...netShop, taxLabel: '   ' }, VAT)).toBe(`+ ${DEFAULT_TAX_LABEL}`)
  })

  it("does not borrow the storefront's own price suffix", () => {
    // A shelf full of prices says what the figure IS ("ex. VAT"); one price
    // quoted to one person says what will happen to it.
    expect(taxSuffix(netShop, VAT)).toBe('+ VAT')
  })

  it('says nothing at all on a shop that has never opened the settings', () => {
    expect(taxSuffix(PLAIN_PRICE_DISPLAY, VAT)).toBeNull()
  })
})

describe('displayIncludesTax', () => {
  it('leaves prices exactly as typed until the shop says otherwise', () => {
    expect(displayIncludesTax(netShop)).toBe(false)
    expect(displayIncludesTax(grossShop)).toBe(true)
  })
})

describe('displayAmount', () => {
  it('does not touch a figure the storefront already agrees with', () => {
    expect(displayAmount(249, netShop, VAT)).toBe(249)
    expect(displayAmount(249, grossShop, VAT)).toBe(249)
  })

  it('adds the tax when the storefront is told to show gross', () => {
    expect(displayAmount(100, { mode: 'INCLUSIVE', storedIncludesTax: false, taxLabel: 'VAT' }, VAT))
      .toBe(120)
  })

  it('takes the tax back off when the storefront is told to show net', () => {
    expect(displayAmount(120, { mode: 'EXCLUSIVE', storedIncludesTax: true, taxLabel: 'VAT' }, VAT))
      .toBe(100)
  })

  it('never moves a zero-rated figure', () => {
    expect(displayAmount(80, { mode: 'INCLUSIVE', storedIncludesTax: false, taxLabel: 'VAT' }, 0))
      .toBe(80)
  })

  it('lands on the penny rather than on a floating-point crumb', () => {
    expect(displayAmount(19.99, { mode: 'INCLUSIVE', storedIncludesTax: false, taxLabel: 'VAT' }, VAT))
      .toBe(23.99)
  })
})

describe('formatPrice', () => {
  it('groups thousands, because £1600.00 reads as a typo on a boardroom table', () => {
    expect(formatPrice(1600, '£')).toBe('£1,600.00')
  })

  it('always shows the pennies', () => {
    expect(formatPrice(7.9, '£')).toBe('£7.90')
  })

  it('uses whatever symbol the shop keeps its money in', () => {
    expect(formatPrice(10, '€')).toBe('€10.00')
  })
})

describe('effectivePrice', () => {
  it('charges the sale price only where sale prices are switched on', () => {
    expect(effectivePrice(249, 199, true)).toBe(199)
    expect(effectivePrice(249, 199, false)).toBe(249)
  })

  it('treats a sale price at or above the normal one as the typo it is', () => {
    expect(effectivePrice(249, 249, true)).toBe(249)
    expect(effectivePrice(249, 300, true)).toBe(249)
  })

  it('ignores a sale price nobody set', () => {
    expect(effectivePrice(249, null, true)).toBe(249)
  })
})
