import { describe, it, expect } from 'vitest'
import { sortByStoredOrder } from './list'

// The top of the rail, in one person's own order.
//
// The cases that matter are all about what the stored order does NOT say. A
// site updates and gains a folder; somebody is taken off an address; a rail
// nobody has ever dragged. Each of those has to leave the rail readable rather
// than shuffled, because the order is read on every single page load of the hub
// and there is no screen anywhere that explains what happened to it.

const rail = (...keys: string[]) => keys.map((key) => ({ key }))
const keys = (items: Array<{ key: string }>) => items.map((i) => i.key)

describe('sortByStoredOrder', () => {
  it('leaves a rail nobody has rearranged exactly as it comes', () => {
    const items = rail('inb_1', 'all', 'mentions', 'sent', 'spam')
    expect(sortByStoredOrder(items, [])).toBe(items)
  })

  it('puts the entries in the order somebody chose', () => {
    expect(keys(sortByStoredOrder(
      rail('inb_1', 'all', 'mentions', 'sent', 'spam'),
      ['sent', 'inb_1', 'spam', 'all', 'mentions'],
    ))).toEqual(['sent', 'inb_1', 'spam', 'all', 'mentions'])
  })

  it('puts an entry the order has never heard of at the end, not in the middle', () => {
    // A folder that arrived with an update. It belongs after the arrangement
    // somebody made rather than in the middle of it.
    expect(keys(sortByStoredOrder(
      rail('inb_1', 'all', 'brand-new'),
      ['all', 'inb_1'],
    ))).toEqual(['all', 'inb_1', 'brand-new'])
  })

  it('keeps two unheard-of entries in the order they arrived in', () => {
    expect(keys(sortByStoredOrder(
      rail('one', 'two', 'all'),
      ['all'],
    ))).toEqual(['all', 'one', 'two'])
  })

  it('ignores a key naming an entry that is no longer on the rail', () => {
    // An address somebody has since been taken off. It costs nothing and is
    // kept in the stored order, so putting them back puts it back where it was.
    expect(keys(sortByStoredOrder(
      rail('all', 'sent'),
      ['inb_gone', 'sent', 'all'],
    ))).toEqual(['sent', 'all'])
  })
})
