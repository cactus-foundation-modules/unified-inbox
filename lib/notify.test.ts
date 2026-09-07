import { describe, expect, it } from 'vitest'
import {
  MAX_LOOKBACK_MS,
  notificationCopy,
  parseSince,
  readPreference,
  senderLabel,
  shouldPoll,
  storageKey,
  writePreference,
  type Arrival,
} from './notify'

const NOW = Date.parse('2026-09-07T12:00:00.000Z')

function arrival(from: string | null, subject: string | null, threadId = 't1'): Arrival {
  return { threadId, subject, from, at: new Date(NOW).toISOString() }
}

describe('parseSince', () => {
  it('takes an instant the browser was handed a moment ago', () => {
    const mark = new Date(NOW - 60_000).toISOString()
    expect(parseSince(mark, NOW)?.toISOString()).toBe(mark)
  })

  it('says nothing at all when there is no mark yet', () => {
    // The first round of a spell away from the screen. It exists to learn what
    // time the server thinks it is, not to announce anything.
    expect(parseSince(null, NOW)).toBeNull()
    expect(parseSince(undefined, NOW)).toBeNull()
    expect(parseSince('', NOW)).toBeNull()
  })

  it('refuses a mark that is not a date', () => {
    expect(parseSince('yesterday', NOW)).toBeNull()
    expect(parseSince('{}', NOW)).toBeNull()
    expect(parseSince('x'.repeat(200), NOW)).toBeNull()
  })

  it('refuses a mark from the future rather than clamping it', () => {
    // Clamping to now would hold the whole backlog behind the clock and let it
    // out in one go the moment the clock crossed the mark.
    expect(parseSince(new Date(NOW + 60_000).toISOString(), NOW)).toBeNull()
  })

  it('never looks further back than the ceiling', () => {
    // A tab left open over a long weekend comes back to a nudge about the last
    // twenty minutes, not about four days.
    const ancient = new Date(NOW - 4 * 24 * 3600_000).toISOString()
    expect(parseSince(ancient, NOW)?.getTime()).toBe(NOW - MAX_LOOKBACK_MS)
  })
})

describe('senderLabel', () => {
  it('uses whoever it is from', () => {
    expect(senderLabel('Ada Lovelace')).toBe('Ada Lovelace')
    expect(senderLabel('  ada@example.com  ')).toBe('ada@example.com')
  })

  it('has something to say about mail with no sender on it', () => {
    expect(senderLabel(null)).toBe('Someone new')
    expect(senderLabel('   ')).toBe('Someone new')
  })
})

describe('notificationCopy', () => {
  it('reads like a message when one thing has landed', () => {
    expect(notificationCopy([arrival('Ada Lovelace', 'Chair quote')], 1, 'Sales')).toEqual({
      title: 'Ada Lovelace',
      body: 'Chair quote',
    })
  })

  it('says so rather than leaving the line blank on a channel with no subject', () => {
    expect(notificationCopy([arrival('07700 900123', null)], 1, null).body).toBe('No subject')
  })

  it('counts them when several have landed', () => {
    const copy = notificationCopy(
      [arrival('Ada', 'One', 't1'), arrival('Bob', 'Two', 't2')],
      2,
      'Purchasing',
    )
    expect(copy.title).toBe('2 new messages')
    expect(copy.body).toBe('Ada, Bob - in Purchasing')
  })

  it('leaves the address out when the reader has no address of their own', () => {
    const copy = notificationCopy([arrival('Ada', 'One', 't1'), arrival('Bob', 'Two', 't2')], 2, null)
    expect(copy.body).toBe('Ada, Bob')
  })

  it('names one person once however many they sent', () => {
    const copy = notificationCopy(
      [arrival('Ada', 'One', 't1'), arrival('Ada', 'Two', 't2'), arrival('Ada', 'Three', 't3')],
      3,
      null,
    )
    expect(copy.body).toBe('Ada')
  })

  it('counts the rest once the names would run off the line', () => {
    const many = ['Ada', 'Bob', 'Cai', 'Dee', 'Eve'].map((n, i) => arrival(n, 'x', `t${i}`))
    expect(notificationCopy(many, 5, null).body).toBe('Ada, Bob, Cai and 2 others')
  })

  it('counts what actually landed rather than what fitted in the round', () => {
    // The round caps how many it fetches. The tally must still be honest about
    // how many there were, or a busy morning reads as five.
    const capped = ['Ada', 'Bob'].map((n, i) => arrival(n, 'x', `t${i}`))
    expect(notificationCopy(capped, 19, null).title).toBe('19 new messages')
  })

  it('tallies rather than singles out when one arrival stands for many', () => {
    expect(notificationCopy([arrival('Ada', 'One')], 6, null).title).toBe('6 new messages')
  })
})

describe('the preference this browser holds', () => {
  function fakeStorage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial))
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { map.set(k, v) },
      map,
    }
  }

  it('is null until somebody has been asked', () => {
    expect(readPreference(fakeStorage(), 'user-1')).toBeNull()
  })

  it('is kept per person, so a shared machine does not answer for the next one', () => {
    const storage = fakeStorage({ [storageKey('user-1')]: 'on' })
    expect(readPreference(storage, 'user-1')).toBe('on')
    expect(readPreference(storage, 'user-2')).toBeNull()
  })

  it('round-trips', () => {
    const storage = fakeStorage()
    writePreference(storage, 'user-1', 'off')
    expect(readPreference(storage, 'user-1')).toBe('off')
  })

  it('ignores a value that is neither', () => {
    expect(readPreference(fakeStorage({ [storageKey('user-1')]: 'maybe' }), 'user-1')).toBeNull()
  })

  it('survives a browser that refuses storage outright', () => {
    // Safari's private windows, and any browser told to block site data. The
    // inbox must open; the nudges are what goes without.
    const throwing = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    }
    expect(readPreference(throwing, 'user-1')).toBeNull()
    expect(() => writePreference(throwing, 'user-1', 'on')).not.toThrow()
    expect(readPreference(null, 'user-1')).toBeNull()
  })
})

describe('shouldPoll', () => {
  const on = { enabled: true, permission: 'granted' as const, focused: false }

  it('asks while the window is behind something else', () => {
    expect(shouldPoll(on)).toBe(true)
  })

  it('asks nothing while somebody is looking at the list', () => {
    // The list in front of them refreshes itself. A round a minute per open tab
    // to tell somebody about a row they can already see is a bill for nothing.
    expect(shouldPoll({ ...on, focused: true })).toBe(false)
  })

  it('asks nothing when it has been turned off, or never granted', () => {
    expect(shouldPoll({ ...on, enabled: false })).toBe(false)
    expect(shouldPoll({ ...on, permission: 'default' })).toBe(false)
    expect(shouldPoll({ ...on, permission: 'denied' })).toBe(false)
    expect(shouldPoll({ ...on, permission: 'unsupported' })).toBe(false)
  })
})
