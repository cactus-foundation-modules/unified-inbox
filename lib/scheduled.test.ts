import { describe, it, expect } from 'vitest'
import {
  MAX_AHEAD_DAYS,
  MAX_FOLLOW_UP_MINUTES,
  MIN_FOLLOW_UP_MINUTES,
  decideFollowUp,
  decideSendAt,
  describeSendAt,
  followUpAt,
  followUpMinutesBetween,
  followUpOptions,
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

describe('a held message in the list', () => {
  const now = new Date('2026-06-01T10:00:00.000Z')

  it('says it was held rather than saying nothing', () => {
    // The state is gone - a stood-down message is an ordinary draft - so the
    // held column is the only thing left that knows why it stopped waiting.
    const label = scheduleLabel(
      { sendAt: new Date('2026-06-02T08:00:00.000Z'), sendState: null, heldByThreadId: 'thr-1' },
      now,
      LONDON,
    )
    expect(label).toBe('Held - they wrote first')
  })

  it('still says when a waiting one goes, held or not', () => {
    const label = scheduleLabel(
      { sendAt: new Date('2026-06-02T08:00:00.000Z'), sendState: 'scheduled', heldByThreadId: null },
      now,
      LONDON,
    )
    expect(label).toMatch(/^Goes out tomorrow at /)
  })
})

describe('decideFollowUp', () => {
  it('takes nothing as no follow-up', () => {
    expect(decideFollowUp(null)).toEqual({ ok: true, minutes: null })
  })

  it('takes the lengths the menu offers', () => {
    expect(decideFollowUp(60 * 24 * 3)).toEqual({ ok: true, minutes: 4320 })
  })

  it('takes three hours, which the menu offers and a day-long floor would have refused', () => {
    expect(decideFollowUp(180)).toEqual({ ok: true, minutes: 180 })
  })

  it('refuses one that would come back before the message has gone', () => {
    expect(decideFollowUp(MIN_FOLLOW_UP_MINUTES - 1).ok).toBe(false)
    expect(decideFollowUp(-60).ok).toBe(false)
  })

  it('refuses one further off than a message may be scheduled at all', () => {
    expect(decideFollowUp(MAX_FOLLOW_UP_MINUTES + 1).ok).toBe(false)
  })

  it('refuses a length that is not a whole number of minutes', () => {
    expect(decideFollowUp(1440.5).ok).toBe(false)
  })
})

describe('followUpOptions', () => {
  const LEAVES = new Date('2026-06-05T20:30:00.000Z')

  it('offers the same three answers, in the same words, as putting one to sleep', () => {
    expect(followUpOptions(LEAVES, LONDON).map((o) => o.label))
      .toEqual(['In three hours', 'Tomorrow morning', 'Next week'])
  })

  it('counts them from when the message goes out, not from now', () => {
    // A message leaving on Friday night is chased on Saturday morning. Counting
    // from now would have made "tomorrow morning" a moment before it had gone.
    const [later, tomorrow, week] = followUpOptions(LEAVES, LONDON)
    expect(later!.until.toISOString()).toBe('2026-06-05T23:30:00.000Z')
    expect(tomorrow!.until.toISOString()).toBe('2026-06-06T08:00:00.000Z')
    expect(week!.until.toISOString()).toBe('2026-06-12T08:00:00.000Z')
  })
})

describe('followUpMinutesBetween', () => {
  it('keeps a chosen moment as the length that is actually stored', () => {
    // The moment is what somebody picks; the length is what survives, so a
    // message that leaves late is chased late.
    const sendAt = new Date('2026-06-05T09:00:00.000Z')
    expect(followUpMinutesBetween(sendAt, new Date('2026-06-08T09:00:00.000Z'))).toBe(4320)
  })

  it('goes negative for a moment before the message leaves, which is refused', () => {
    const sendAt = new Date('2026-06-05T09:00:00.000Z')
    const minutes = followUpMinutesBetween(sendAt, new Date('2026-06-05T08:00:00.000Z'))
    expect(minutes).toBe(-60)
    expect(decideFollowUp(minutes).ok).toBe(false)
  })
})

describe('followUpAt', () => {
  it('counts from when the message actually left, not from when it was set', () => {
    // A message that went out late is chased late: the whole reason the length
    // is stored rather than the moment.
    const left = new Date('2026-06-02T09:07:00.000Z')
    expect(followUpAt(left, 60 * 24 * 3).toISOString()).toBe('2026-06-05T09:07:00.000Z')
  })
})
