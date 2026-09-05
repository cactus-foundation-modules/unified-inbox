import { describe, expect, it } from 'vitest'
import { buildAudience, decideAudience, groupExclusions, type AudienceCandidate, type AudienceGate } from './audience'

// Who is on the list, and who is not, and why. Every exclusion below is one a
// real address book produces.

function candidate(patch: Partial<AudienceCandidate> = {}): AudienceCandidate {
  return {
    personId: 'p1',
    address: 'jane@acme.co.uk',
    firstName: 'Jane',
    lastName: 'Smith',
    displayName: 'Jane Smith',
    organisationName: 'Acme Ltd',
    ...patch,
  }
}

function gate(patch: Partial<AudienceGate> = {}): AudienceGate {
  return {
    suppressed: new Set<string>(),
    recentlyMailed: new Set<string>(),
    ownDomains: ['deskwell.co.uk'],
    excludeColleagues: true,
    cooldownDays: 7,
    ...patch,
  }
}

describe('one contact at a time', () => {
  it('includes an ordinary customer', () => {
    expect(decideAudience(candidate(), gate())).toEqual({ include: true, address: 'jane@acme.co.uk' })
  })

  it('normalises the address on the way in', () => {
    const decision = decideAudience(candidate({ address: ' Jane@ACME.co.uk ' }), gate())
    expect(decision).toEqual({ include: true, address: 'jane@acme.co.uk' })
  })

  it('leaves out somebody with no address', () => {
    const decision = decideAudience(candidate({ address: '' }), gate())
    expect(decision).toEqual({ include: false, reason: 'No email address on their record.' })
  })

  it('leaves out an address that will never work', () => {
    const decision = decideAudience(candidate({ address: 'not an address' }), gate())
    expect(decision.include).toBe(false)
  })

  it('leaves out anybody who has unsubscribed or bounced', () => {
    const decision = decideAudience(candidate(), gate({ suppressed: new Set(['jane@acme.co.uk']) }))
    expect(decision).toEqual({
      include: false,
      reason: 'They have unsubscribed, or their address has bounced.',
    })
  })

  it('leaves colleagues out, which is what stops a mailshot going round the office', () => {
    const marcus = candidate({ address: 'marcus@deskwell.co.uk' })
    expect(decideAudience(marcus, gate())).toEqual({
      include: false,
      reason: 'They are a colleague rather than a customer.',
    })
    // Unless somebody has deliberately said otherwise.
    expect(decideAudience(marcus, gate({ excludeColleagues: false })).include).toBe(true)
  })

  it('holds back somebody another campaign wrote to this week, and says how long', () => {
    const decision = decideAudience(candidate(), gate({ recentlyMailed: new Set(['jane@acme.co.uk']) }))
    expect(decision).toEqual({
      include: false,
      reason: 'Another campaign wrote to them in the last 7 days.',
    })
  })

  it('says "day" rather than "days" when the cooldown is one', () => {
    const decision = decideAudience(candidate(), gate({
      recentlyMailed: new Set(['jane@acme.co.uk']),
      cooldownDays: 1,
    }))
    expect(decision).toEqual({
      include: false,
      reason: 'Another campaign wrote to them in the last 1 day.',
    })
  })

  it('reports the address problem ahead of the timing one', () => {
    // Worth knowing that the address is dead even about somebody the cooldown
    // would also have held back.
    const decision = decideAudience(candidate(), gate({
      suppressed: new Set(['jane@acme.co.uk']),
      recentlyMailed: new Set(['jane@acme.co.uk']),
    }))
    expect(decision).toEqual({
      include: false,
      reason: 'They have unsubscribed, or their address has bounced.',
    })
  })
})

describe('the whole list', () => {
  it('collapses two contacts sharing one address into one email', () => {
    const built = buildAudience([
      candidate({ personId: 'p1' }),
      candidate({ personId: 'p2', firstName: 'John', displayName: 'John Smith' }),
    ], gate())
    expect(built.included).toHaveLength(1)
    expect(built.duplicates).toBe(1)
    // The first one wins, which is the one the query ordered first - arbitrary,
    // but stable, so building the same list twice gives the same list.
    expect(built.included[0]!.personId).toBe('p1')
  })

  it('collapses the same person appearing under two labels', () => {
    const built = buildAudience([candidate(), candidate()], gate())
    expect(built.included).toHaveLength(1)
    expect(built.duplicates).toBe(1)
  })

  it('keeps everybody who is left out, with the reason', () => {
    const built = buildAudience([
      candidate(),
      candidate({ personId: 'p2', address: 'marcus@deskwell.co.uk' }),
      candidate({ personId: 'p3', address: '' }),
    ], gate())
    expect(built.included).toHaveLength(1)
    expect(built.excluded).toHaveLength(2)
    expect(built.excluded.map((e) => e.candidate.personId)).toEqual(['p2', 'p3'])
  })

  it('does not count an excluded contact as a duplicate as well', () => {
    const built = buildAudience([
      candidate({ address: 'marcus@deskwell.co.uk' }),
      candidate({ personId: 'p2', address: 'marcus@deskwell.co.uk' }),
    ], gate())
    expect(built.included).toHaveLength(0)
    expect(built.excluded).toHaveLength(2)
    expect(built.duplicates).toBe(0)
  })
})

describe('grouping the exclusions for the screen', () => {
  it('counts them, biggest first', () => {
    const grouped = groupExclusions([
      { reason: 'They have unsubscribed, or their address has bounced.' },
      { reason: 'No email address on their record.' },
      { reason: 'They have unsubscribed, or their address has bounced.' },
    ])
    expect(grouped).toEqual([
      { reason: 'They have unsubscribed, or their address has bounced.', count: 2 },
      { reason: 'No email address on their record.', count: 1 },
    ])
  })
})
