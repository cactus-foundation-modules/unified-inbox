import { describe, it, expect } from 'vitest'
import { ownPostAssignee, ownPostOwnerMap, type OwnedInbox } from './own-post'

// Every case in here is an absence, and each absence is a conversation filed
// under the wrong name - or hidden behind a name nobody can log in as - if the
// rule goes the other way.

const shared = (id: string): OwnedInbox => ({ id, kind: 'shared', ownerUserId: null })
const own = (id: string, ownerUserId: string | null): OwnedInbox =>
  ({ id, kind: 'individual', ownerUserId })

const ACTIVE = new Set(['emma', 'marcus'])

describe('ownPostOwnerMap', () => {
  it('names the owner of an individual address', () => {
    expect(ownPostOwnerMap([own('i1', 'emma')], ACTIVE).get('i1')).toBe('emma')
  })

  it('leaves a shared address out, whoever is named on its guest list', () => {
    expect(ownPostOwnerMap([shared('sales')], ACTIVE).has('sales')).toBe(false)
  })

  it('leaves out an individual address whose owner has been deleted', () => {
    expect(ownPostOwnerMap([own('i1', null)], ACTIVE).has('i1')).toBe(false)
  })

  it('leaves out an owner who can no longer log in', () => {
    expect(ownPostOwnerMap([own('i1', 'departed')], ACTIVE).has('i1')).toBe(false)
  })

  it('keeps one address per person and one person per address', () => {
    const owners = ownPostOwnerMap([own('i1', 'emma'), own('i2', 'marcus'), shared('sales')], ACTIVE)
    expect([...owners]).toEqual([['i1', 'emma'], ['i2', 'marcus']])
  })
})

describe('ownPostAssignee', () => {
  const owners = ownPostOwnerMap([own('i1', 'emma'), shared('sales')], ACTIVE)

  it('hands inbound post at somebody’s own address to them', () => {
    expect(ownPostAssignee('in', 'i1', owners)).toBe('emma')
  })

  it('ignores the copy of their own reply coming back out of Sent', () => {
    expect(ownPostAssignee('out', 'i1', owners)).toBeNull()
  })

  it('ignores a shared address', () => {
    expect(ownPostAssignee('in', 'sales', owners)).toBeNull()
  })

  it('ignores mail that could not be placed at all', () => {
    expect(ownPostAssignee('in', null, owners)).toBeNull()
  })

  it('ignores an address that has since been deleted', () => {
    expect(ownPostAssignee('in', 'gone', owners)).toBeNull()
  })
})
