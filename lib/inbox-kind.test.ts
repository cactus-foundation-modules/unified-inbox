import { describe, it, expect } from 'vitest'
import { kindProblem } from './inbox-kind'

// Both routes have to reach the same answer about a saved inbox: a create that
// accepts what an edit refuses is a way round the rule, and the rule is the one
// keeping somebody's own post to themselves.

describe('kindProblem', () => {
  it('has no opinion about a shared inbox', () => {
    expect(kindProblem({ kind: 'shared', ownerUserId: null, isCatchAll: false })).toBeNull()
    expect(kindProblem({ kind: 'shared', ownerUserId: null, isCatchAll: true })).toBeNull()
  })

  it('accepts a personal inbox that has somebody on the end of it', () => {
    expect(kindProblem({ kind: 'individual', ownerUserId: 'u1', isCatchAll: false })).toBeNull()
  })

  it('refuses a personal inbox with nobody named', () => {
    expect(kindProblem({ kind: 'individual', ownerUserId: null, isCatchAll: false }))
      .toMatch(/whose inbox this is/i)
  })

  it('refuses to file unplaceable post into somebody’s own inbox', () => {
    expect(kindProblem({ kind: 'individual', ownerUserId: 'u1', isCatchAll: true }))
      .toMatch(/catch-all/i)
  })
})
