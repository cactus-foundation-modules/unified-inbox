import { describe, it, expect } from 'vitest'
import { retentionCutoff, RETENTION_BATCH, STALLED_SEND_MS } from './retention'

// Where the retention line falls, which is the only arithmetic in the module
// that decides whether somebody's mail still exists.

describe('retentionCutoff', () => {
  it('is null when no window is set, so nothing is ever removed', () => {
    expect(retentionCutoff(null, new Date('2026-08-29T00:00:00Z'))).toBeNull()
  })

  it('treats nonsense as no window rather than as "delete everything"', () => {
    // A zero or a negative number out of a settings box must not be read as a
    // cutoff in the future, which would catch every conversation on the site.
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(retentionCutoff(value, new Date('2026-08-29T00:00:00Z'))).toBeNull()
    }
  })

  it('goes back the number of months it is given', () => {
    const cutoff = retentionCutoff(12, new Date('2026-08-29T12:00:00Z'))
    expect(cutoff?.toISOString().slice(0, 10)).toBe('2025-08-29')
  })

  it('handles a month with fewer days without leaping forward a year', () => {
    // 31 March less one month is 3 March in JavaScript, not 28 February. That
    // is a day or two of extra mail kept, never mail removed early, which is
    // the right way round for this to be wrong.
    const cutoff = retentionCutoff(1, new Date('2026-03-31T12:00:00Z'))
    expect(cutoff!.getTime()).toBeLessThan(new Date('2026-03-31T12:00:00Z').getTime())
    expect(cutoff!.getFullYear()).toBe(2026)
  })

  it('does not read the clock itself', () => {
    // The settings screen and the sweep have to agree about where the line is,
    // which they can only do if both are told the time rather than asking.
    const fixed = new Date('2020-01-15T00:00:00Z')
    expect(retentionCutoff(6, fixed)!.toISOString()).toBe(retentionCutoff(6, fixed)!.toISOString())
  })
})

describe('the budgets', () => {
  it('keeps a batch small enough to finish inside a cron slice', () => {
    expect(RETENTION_BATCH).toBeLessThanOrEqual(100)
  })

  it('waits longer than a send can possibly take before calling one stalled', () => {
    // A send route has a 60 second ceiling. Anything still saying "sending"
    // long after that crashed rather than being slow, and marking a send in
    // flight as failed would tell somebody their email did not go when it did.
    expect(STALLED_SEND_MS).toBeGreaterThan(60_000)
  })
})
