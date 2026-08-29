import { describe, it, expect } from 'vitest'
import { defaultLinkKind, type LinkKindOption } from './link-kinds'
import { likeTerm } from './adapters/format'

// Which kind of record the attach picker opens on. It is a small decision made
// on every conversation, which is exactly why getting it wrong is expensive:
// the wrong answer is one more choice for somebody, forty times a morning.

const ORDER: LinkKindOption = { id: 'order', label: 'Order', moduleName: 'shop' }
const PO: LinkKindOption = { id: 'po', label: 'Purchase order', moduleName: 'purchase-orders' }
const QUOTE: LinkKindOption = { id: 'quote', label: 'Quote', moduleName: 'quote-for-shop' }

describe('defaultLinkKind', () => {
  it('opens on purchase orders in the address purchasing sends from', () => {
    expect(defaultLinkKind([ORDER, QUOTE, PO], ['purchase-orders'])).toBe('po')
  })

  it('opens on orders in the shop’s address', () => {
    expect(defaultLinkKind([ORDER, QUOTE, PO], ['shop'])).toBe('order')
  })

  it('takes the site’s own order when one address serves two modules', () => {
    expect(defaultLinkKind([ORDER, PO], ['purchase-orders', 'shop'])).toBe('po')
    expect(defaultLinkKind([ORDER, PO], ['shop', 'purchase-orders'])).toBe('order')
  })

  it('falls back to the first kind for an address nothing sends from', () => {
    expect(defaultLinkKind([ORDER, PO], [])).toBe('order')
  })

  it('ignores a module that has nothing to attach', () => {
    // Bookkeeping sends its own post but keeps nothing anybody attaches by
    // hand, so it must not leave the picker on no choice at all.
    expect(defaultLinkKind([ORDER, PO], ['uk-bookkeeping'])).toBe('order')
  })

  it('has no answer when there is nothing to attach anywhere', () => {
    expect(defaultLinkKind([], ['shop'])).toBeNull()
  })
})

describe('likeTerm', () => {
  it('wraps the term for a contains search', () => {
    expect(likeTerm('4471')).toBe('%4471%')
    expect(likeTerm('  desk  ')).toBe('%desk%')
  })

  it('takes a wildcard in the term literally', () => {
    // Somebody searching PO_2026 means that underscore, and LIKE reads a bare
    // one as "any character".
    expect(likeTerm('PO_2026')).toBe('%PO\\_2026%')
    expect(likeTerm('50%')).toBe('%50\\%%')
    expect(likeTerm('a\\b')).toBe('%a\\\\b%')
  })
})
