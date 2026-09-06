import { describe, it, expect } from 'vitest'
import {
  MAX_MERGE_SOURCES,
  effectiveInboxIds,
  listSentence,
  mergeSummary,
  mergedInboxIds,
  mergedStatus,
  mergedUnread,
  pickWinner,
  validateMerge,
  widenedAccessWarning,
  type MergeCandidate,
} from './thread-merge'

const at = (iso: string) => new Date(iso)

function candidate(over: Partial<MergeCandidate> & { id: string }): MergeCandidate {
  return {
    inboxId: null,
    subject: null,
    status: 'open',
    unread: false,
    createdAt: at('2026-01-01T00:00:00.000Z'),
    ...over,
  }
}

describe('pickWinner', () => {
  it('folds the later conversations into the one that started it', () => {
    const winner = pickWinner([
      { id: 'b', createdAt: at('2026-03-02T09:00:00.000Z') },
      { id: 'a', createdAt: at('2026-02-11T17:30:00.000Z') },
      { id: 'c', createdAt: at('2026-03-04T08:00:00.000Z') },
    ])
    expect(winner?.id).toBe('a')
  })

  it('answers the same whichever order they were ticked', () => {
    const rows = [
      { id: 'zed', createdAt: at('2026-02-11T17:30:00.000Z') },
      { id: 'abc', createdAt: at('2026-02-11T17:30:00.000Z') },
    ]
    expect(pickWinner(rows)?.id).toBe('abc')
    expect(pickWinner([...rows].reverse())?.id).toBe('abc')
  })

  it('has nothing to say about nothing', () => {
    expect(pickWinner([])).toBeNull()
  })
})

describe('which addresses a conversation belongs to', () => {
  it('is its own inbox when it has never been merged', () => {
    expect(effectiveInboxIds({ inboxId: 'hi' })).toEqual(['hi'])
  })

  it('is nothing at all for a chat, which never had an address', () => {
    expect(effectiveInboxIds({ inboxId: null })).toEqual([])
  })

  it('is the absorbed list once there is one, not a union of the two', () => {
    // The winner's own inbox is written into the list at merge time, so reading
    // both and concatenating would list it twice and count it twice.
    expect(effectiveInboxIds({ inboxId: 'hi', absorbedInboxIds: ['hi', 'marcus'] }))
      .toEqual(['hi', 'marcus'])
  })

  it('collects every side, once each, in the order they were met', () => {
    const winner = candidate({ id: 'w', inboxId: 'hi' })
    const losers = [
      candidate({ id: 'l1', inboxId: 'marcus' }),
      candidate({ id: 'l2', inboxId: 'hi' }),
      candidate({ id: 'l3', inboxId: 'accounts', absorbedInboxIds: ['accounts', 'sales'] }),
      candidate({ id: 'l4', inboxId: null }),
    ]
    expect(mergedInboxIds(winner, losers)).toEqual(['hi', 'marcus', 'accounts', 'sales'])
  })
})

describe('what the merged conversation says about itself', () => {
  it('is open if any side of it was still open', () => {
    expect(mergedStatus(['done', 'open', 'done'])).toBe('open')
  })

  it('stays asleep only while every side is', () => {
    expect(mergedStatus(['snoozed', 'snoozed'])).toBe('snoozed')
    expect(mergedStatus(['snoozed', 'done'])).toBe('snoozed')
    expect(mergedStatus(['done', 'done'])).toBe('done')
  })

  it('is unread if any side was', () => {
    expect(mergedUnread([false, true, false])).toBe(true)
    expect(mergedUnread([false, false])).toBe(false)
  })
})

describe('validateMerge', () => {
  type Found = Map<string, { mergedIntoId: string | null }>
  const open: { mergedIntoId: string | null } = { mergedIntoId: null }

  it('refuses a merge with nothing to merge in', () => {
    expect(validateMerge({ winnerId: 'w', loserIds: [], found: new Map([['w', open]]) }))
      .toEqual({ error: 'Pick at least one other conversation to merge in.' })
  })

  it('refuses a conversation merged into itself', () => {
    expect(validateMerge({ winnerId: 'w', loserIds: ['w'], found: new Map([['w', open]]) }))
      .toEqual({ error: 'A conversation cannot be merged into itself.' })
  })

  it('refuses more than the cap', () => {
    const loserIds = Array.from({ length: MAX_MERGE_SOURCES + 1 }, (_, i) => `l${i}`)
    const found = new Map([['w', open], ...loserIds.map((id) => [id, open] as const)])
    expect(validateMerge({ winnerId: 'w', loserIds, found })?.error)
      .toContain(`more than ${MAX_MERGE_SOURCES}`)
  })

  it('refuses when one of them has gone', () => {
    expect(validateMerge({ winnerId: 'w', loserIds: ['gone'], found: new Map([['w', open]]) }))
      .toEqual({ error: 'One of those conversations is no longer here.' })
  })

  it('refuses to merge INTO something already merged away, and says where to go', () => {
    const found: Found = new Map([['w', { mergedIntoId: 'other' }], ['l', open]])
    expect(validateMerge({ winnerId: 'w', loserIds: ['l'], found })?.error)
      .toContain('Merge into that one instead')
  })

  it('refuses to merge away something already merged away', () => {
    const found: Found = new Map([['w', open], ['l', { mergedIntoId: 'other' }]])
    expect(validateMerge({ winnerId: 'w', loserIds: ['l'], found })?.error)
      .toContain('Undo that first')
  })

  it('lets an ordinary merge through, duplicates in the list included', () => {
    const found = new Map([['w', open], ['a', open], ['b', open]])
    expect(validateMerge({ winnerId: 'w', loserIds: ['a', 'b', 'a'], found })).toBeNull()
  })
})

describe('the warning about who will be able to read it', () => {
  const inboxNames = new Map([['hi', 'Enquiries'], ['marcus', 'Marcus Ashford'], ['acc', 'Accounts']])

  it('says nothing when everything is already on one address', () => {
    expect(widenedAccessWarning({
      winner: candidate({ id: 'w', inboxId: 'hi' }),
      losers: [candidate({ id: 'l', inboxId: 'hi' })],
      inboxNames,
    })).toBeNull()
  })

  it('names both addresses when a merge spans two of them', () => {
    expect(widenedAccessWarning({
      winner: candidate({ id: 'w', inboxId: 'hi' }),
      losers: [candidate({ id: 'l', inboxId: 'marcus' })],
      inboxNames,
    })).toBe('Everyone who can read Enquiries and Marcus Ashford will be able to read the whole of the merged conversation.')
  })

  it('names three without an Oxford comma', () => {
    expect(widenedAccessWarning({
      winner: candidate({ id: 'w', inboxId: 'hi' }),
      losers: [candidate({ id: 'a', inboxId: 'marcus' }), candidate({ id: 'b', inboxId: 'acc' })],
      inboxNames,
    })).toContain('Enquiries, Marcus Ashford and Accounts')
  })

  it('does not invent a name for an address it was not given one for', () => {
    expect(widenedAccessWarning({
      winner: candidate({ id: 'w', inboxId: 'hi' }),
      losers: [candidate({ id: 'l', inboxId: 'nobody-told-us' })],
      inboxNames,
    })).toContain('another address')
  })
})

describe('copy', () => {
  it('joins a list the British way round', () => {
    expect(listSentence([])).toBe('')
    expect(listSentence(['one'])).toBe('one')
    expect(listSentence(['one', 'two'])).toBe('one and two')
    expect(listSentence(['one', 'two', 'three'])).toBe('one, two and three')
  })

  it('reports what happened using the subject people recognise', () => {
    const winner = candidate({ id: 'w', subject: 'Artisan Furniture' })
    expect(mergeSummary(winner, 1)).toBe('Merged into Artisan Furniture.')
    expect(mergeSummary(winner, 3)).toBe('3 conversations merged into Artisan Furniture.')
  })

  it('does not say "into null" when nobody gave it a subject', () => {
    expect(mergeSummary(candidate({ id: 'w', subject: '  ' }), 1)).toBe('Merged into the conversation.')
  })
})
