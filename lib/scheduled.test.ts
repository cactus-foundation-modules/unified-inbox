import { describe, it, expect } from 'vitest'
import {
  MAX_AHEAD_DAYS,
  decideSendAt,
  describeSendAt,
  plainTextToHtml,
  scheduleLabel,
  toWallClock,
} from './scheduled'

// The zone is London on purpose: half the year it is UTC and half the year it
// is an hour ahead, which is the only way to catch a wall clock being read as
// if the server's own zone were the site's.
const LONDON = 'Europe/London'

describe('decideSendAt', () => {
  const now = new Date('2026-06-01T10:00:00.000Z') // 11:00 in London

  it('reads a typed wall clock in the site zone, not the server one', () => {
    const decision = decideSendAt('2026-06-02T09:00', now, LONDON)
    expect(decision.ok).toBe(true)
    // Nine in the morning in London in June is eight o'clock UTC. Reading it as
    // UTC would have sent it an hour early.
    if (decision.ok) expect(decision.at.toISOString()).toBe('2026-06-02T08:00:00.000Z')
  })

  it('reads the same clock an hour differently in winter', () => {
    const winter = new Date('2026-01-01T10:00:00.000Z')
    const decision = decideSendAt('2026-01-02T09:00', winter, LONDON)
    expect(decision.ok).toBe(true)
    if (decision.ok) expect(decision.at.toISOString()).toBe('2026-01-02T09:00:00.000Z')
  })

  it('takes the seconds some browsers add', () => {
    expect(decideSendAt('2026-06-02T09:00:00', now, LONDON).ok).toBe(true)
  })

  it('refuses a time that has been and gone', () => {
    const decision = decideSendAt('2026-05-30T09:00', now, LONDON)
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.reason).toMatch(/been and gone/)
  })

  it('refuses a time barely ahead of now, which is what Send is for', () => {
    const decision = decideSendAt('2026-06-01T11:00', now, LONDON)
    expect(decision.ok).toBe(false)
  })

  it('refuses a year that is plainly a typo', () => {
    const decision = decideSendAt('2126-06-02T09:00', now, LONDON)
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.reason).toMatch(/more than a year/)
  })

  it('accepts something inside the ceiling', () => {
    const at = new Date(now.getTime() + (MAX_AHEAD_DAYS - 2) * 86_400_000)
    const wall = toWallClock(at, LONDON)
    expect(decideSendAt(wall, now, LONDON).ok).toBe(true)
  })

  it('refuses anything that is not a date and a time', () => {
    for (const value of ['', 'tomorrow', '2026-06-02', '02/06/2026 09:00']) {
      expect(decideSendAt(value, now, LONDON).ok).toBe(false)
    }
  })
})

describe('toWallClock', () => {
  it('gives back the clock that was typed', () => {
    const now = new Date('2026-06-01T10:00:00.000Z')
    const decision = decideSendAt('2026-06-02T09:30', now, LONDON)
    expect(decision.ok).toBe(true)
    if (decision.ok) expect(toWallClock(decision.at, LONDON)).toBe('2026-06-02T09:30')
  })

  it('says midnight as a value the box will take', () => {
    const at = new Date('2026-06-02T23:00:00.000Z') // midnight in London
    expect(toWallClock(at, LONDON)).toBe('2026-06-03T00:00')
  })
})

describe('describeSendAt', () => {
  const now = new Date('2026-06-01T10:00:00.000Z')

  it('says today and tomorrow rather than a date', () => {
    expect(describeSendAt(new Date('2026-06-01T16:00:00.000Z'), now, LONDON)).toMatch(/^today at /)
    expect(describeSendAt(new Date('2026-06-02T08:00:00.000Z'), now, LONDON)).toMatch(/^tomorrow at /)
  })

  it('names the day further out', () => {
    expect(describeSendAt(new Date('2026-06-10T08:00:00.000Z'), now, LONDON)).toMatch(/10 Jun at /)
  })

  it('carries the year when it is not this one', () => {
    expect(describeSendAt(new Date('2027-01-10T08:00:00.000Z'), now, LONDON)).toMatch(/2027/)
  })

  it('says nothing at all about nothing', () => {
    expect(describeSendAt(null, now, LONDON)).toBe('')
  })
})

describe('scheduleLabel', () => {
  const now = new Date('2026-06-01T10:00:00.000Z')

  it('says nothing for an ordinary draft', () => {
    expect(scheduleLabel({ sendAt: null, sendState: null }, now, LONDON)).toBe('')
  })

  it('says when a waiting one goes', () => {
    const label = scheduleLabel(
      { sendAt: new Date('2026-06-02T08:00:00.000Z'), sendState: 'scheduled' },
      now,
      LONDON,
    )
    expect(label).toMatch(/^Goes out tomorrow at /)
  })

  it('says plainly when one did not go', () => {
    expect(scheduleLabel({ sendAt: new Date(), sendState: 'failed' }, now, LONDON)).toBe('Did not go out')
  })
})

describe('plainTextToHtml', () => {
  it('escapes what would otherwise be markup', () => {
    expect(plainTextToHtml('<b>Ben & Co</b>')).toBe('&lt;b&gt;Ben &amp; Co&lt;/b&gt;')
  })

  it('keeps the line breaks somebody typed', () => {
    expect(plainTextToHtml('One\r\nTwo\nThree')).toBe('One<br>Two<br>Three')
  })
})
