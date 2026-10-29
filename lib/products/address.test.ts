import { describe, it, expect } from 'vitest'
import { isSingleAddress, slugFromProductAddress } from './address'

const SITE = 'https://example.com'

describe('slugFromProductAddress', () => {
  it('reads the slug off a shop-style address', () => {
    expect(slugFromProductAddress('https://example.com/shop/products/oslo-chair', SITE, false)).toBe('oslo-chair')
  })

  it('reads a shop-style address even where the shop publishes at the root', () => {
    expect(slugFromProductAddress('https://example.com/shop/products/oslo-chair', SITE, true)).toBe('oslo-chair')
  })

  it('reads a root address only where the shop publishes there', () => {
    expect(slugFromProductAddress('https://example.com/oslo-chair', SITE, true)).toBe('oslo-chair')
    expect(slugFromProductAddress('https://example.com/oslo-chair', SITE, false)).toBeNull()
  })

  it('ignores www, a trailing slash, the query and the fragment', () => {
    expect(slugFromProductAddress('https://www.example.com/oslo-chair/?utm_source=x#reviews', SITE, true)).toBe('oslo-chair')
    expect(slugFromProductAddress('https://example.com/oslo-chair', 'https://www.example.com', true)).toBe('oslo-chair')
  })

  it('decodes an encoded slug', () => {
    expect(slugFromProductAddress('https://example.com/shop/products/caf%C3%A9-table', SITE, false)).toBe('café-table')
  })

  it('refuses somebody else\'s site, other schemes and deeper paths', () => {
    expect(slugFromProductAddress('https://elsewhere.com/shop/products/oslo-chair', SITE, false)).toBeNull()
    expect(slugFromProductAddress('ftp://example.com/shop/products/oslo-chair', SITE, false)).toBeNull()
    expect(slugFromProductAddress('https://example.com/blog/2026/oslo', SITE, true)).toBeNull()
    expect(slugFromProductAddress('https://example.com/', SITE, true)).toBeNull()
  })

  it('refuses everything with no site address to compare against', () => {
    expect(slugFromProductAddress('https://example.com/oslo-chair', null, true)).toBeNull()
  })

  it('refuses nonsense rather than throwing', () => {
    expect(slugFromProductAddress('not a url', SITE, true)).toBeNull()
    expect(slugFromProductAddress('https://example.com/%E0%A4%A', SITE, true)).toBeNull()
  })
})

describe('isSingleAddress', () => {
  it('is one address and nothing else', () => {
    expect(isSingleAddress('  https://example.com/oslo-chair \n')).toBe(true)
    expect(isSingleAddress('have a look at https://example.com/oslo-chair')).toBe(false)
    expect(isSingleAddress('example.com/oslo-chair')).toBe(false)
  })
})
