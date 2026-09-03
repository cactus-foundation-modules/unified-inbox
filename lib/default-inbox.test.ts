import { describe, it, expect } from 'vitest'
import { effectiveInboxParam, moveInOrder, pinDefaultInbox } from './list'
import { chooseSignatureSource, type SignatureSource } from './signature'

// An address of one's own: what the hub opens on, where it sits along the top,
// and whose signature goes at the foot of a reply. Every rule here is one a
// person would have to click through six screens to check, and each of them
// broke something quietly the first time it was written down wrong.

describe('effectiveInboxParam', () => {
  it('opens on the address of your own when the URL names no tab', () => {
    expect(effectiveInboxParam(undefined, 'inb_purchasing')).toBe('inb_purchasing')
  })

  it('opens on All when you have not been given one', () => {
    expect(effectiveInboxParam(undefined, null)).toBeUndefined()
  })

  it('leaves the URL alone when it does name a tab', () => {
    expect(effectiveInboxParam('all', 'inb_purchasing')).toBe('all')
    expect(effectiveInboxParam('drafts', 'inb_purchasing')).toBe('drafts')
    expect(effectiveInboxParam('m:live-chat', 'inb_purchasing')).toBe('m:live-chat')
  })
})

describe('pinDefaultInbox', () => {
  const inboxes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('pulls the address out of the row and leaves the rest in order', () => {
    const { pinned, rest } = pinDefaultInbox(inboxes, 'b')
    expect(pinned?.id).toBe('b')
    expect(rest.map((i) => i.id)).toEqual(['a', 'c'])
  })

  it('pins nothing when there is none', () => {
    const { pinned, rest } = pinDefaultInbox(inboxes, null)
    expect(pinned).toBeNull()
    expect(rest).toBe(inboxes)
  })

  it('pins nothing when the address is one this person cannot see', () => {
    // Taken off the guest list, or deleted, long after it was made theirs. A
    // tab that opens on "that inbox is not here" is worse than no tab.
    const { pinned, rest } = pinDefaultInbox(inboxes, 'gone')
    expect(pinned).toBeNull()
    expect(rest.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('dragging while one address is pinned', () => {
  // The row is drawn as [pinned, All, ...rest] and saved as the site's own
  // order. Pinning is one person's preference, so a drag must move things
  // within the site order without dragging the pinned address along with it.
  const order = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]

  /** What the component does on a drop: rest indices in, site order out. */
  function drop(defaultInboxId: string | null, from: number, to: number) {
    const { rest } = pinDefaultInbox(order, defaultInboxId)
    return moveInOrder(
      order,
      order.findIndex((i) => i.id === rest[from]!.id),
      order.findIndex((i) => i.id === rest[to]!.id),
    ).map((i) => i.id)
  }

  it('moves an address to the end of the row without disturbing the pinned one', () => {
    expect(drop('b', 0, 2)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('moves one to the front of the row', () => {
    expect(drop('b', 2, 0)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('behaves exactly as it always did when nothing is pinned', () => {
    expect(drop(null, 0, 3)).toEqual(['b', 'c', 'd', 'a'])
  })
})

const INBOX: SignatureSource = {
  signatureKind: 'markdown',
  signature: null,
  signatureHtml: null,
  signaturePuck: null,
  name: 'Purchasing',
  address: 'purchasing@example.com',
  fromName: null,
}

describe('chooseSignatureSource', () => {
  const purchasing = { ...INBOX, signature: 'The purchasing department' }
  const mine = { ...INBOX, name: 'Mine', address: 'jo@example.com', signature: 'Jo Bloggs' }

  it('signs off with your own address wherever you are sending from', () => {
    expect(chooseSignatureSource(mine, purchasing)).toBe(mine)
  })

  it('falls back to the address the reply is leaving from when yours has none', () => {
    expect(chooseSignatureSource({ ...mine, signature: '   ' }, purchasing)).toBe(purchasing)
  })

  it('is the address being sent from for anybody without one of their own', () => {
    expect(chooseSignatureSource(null, purchasing)).toBe(purchasing)
  })

  it('is the address being sent from when that address is somebody’s own', () => {
    // A reply leaving marcus@ is from Marcus whoever pressed Send.
    expect(chooseSignatureSource(mine, purchasing, true)).toBe(purchasing)
  })
})
