import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WINDOW,
  addCalendarDays,
  clockToMinute,
  daysAfter,
  forecastFinish,
  gapAfterSend,
  isCalendarDate,
  isInsideWindow,
  isSendingDay,
  minutesOfDayIn,
  minuteToClock,
  nextSlot,
  rampCapForDay,
  slotsPerDay,
  weekdayOfCalendarDate,
} from './window'
import type { SendWindow } from './types'

// The clock. Everything here is the sort of thing that is obviously right until
// the last Sunday in October, so it is a test rather than a memory.

const LONDON = 'Europe/London'

function windowOf(patch: Partial<SendWindow> = {}): SendWindow {
  return { ...DEFAULT_WINDOW, ...patch }
}

describe('which days it sends on', () => {
  it('knows a Saturday from a Tuesday', () => {
    // 2026-09-05 is a Saturday, 2026-09-08 a Tuesday.
    expect(weekdayOfCalendarDate('2026-09-05')).toBe(6)
    expect(weekdayOfCalendarDate('2026-09-08')).toBe(2)
  })

  it('sits out weekends when told to, and does not when not', () => {
    expect(isSendingDay('2026-09-05', windowOf())).toBe(false)
    expect(isSendingDay('2026-09-08', windowOf())).toBe(true)
    expect(isSendingDay('2026-09-05', windowOf({ weekdaysOnly: false }))).toBe(true)
  })

  it('sits out the days it was told to sit out', () => {
    const christmas = windowOf({ skipDates: ['2026-12-25'] })
    // A Friday, and a working day by every other rule.
    expect(weekdayOfCalendarDate('2026-12-25')).toBe(5)
    expect(isSendingDay('2026-12-25', christmas)).toBe(false)
  })

  it('counts calendar days without tripping over month ends', () => {
    expect(addCalendarDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addCalendarDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('the window itself', () => {
  it('reads the clock in the site zone, not the machine', () => {
    // 08:30 UTC in July is 09:30 in London. A machine keeping UTC would call
    // this half past eight and start half an hour early.
    const summerMorning = new Date('2026-07-07T08:30:00Z')
    expect(minutesOfDayIn(summerMorning, LONDON)).toBe(9 * 60 + 30)
    expect(minutesOfDayIn(summerMorning, 'UTC')).toBe(8 * 60 + 30)
  })

  it('is inside on a Tuesday morning and outside at midnight', () => {
    expect(isInsideWindow(new Date('2026-09-08T09:00:00Z'), windowOf(), LONDON)).toBe(true)
    expect(isInsideWindow(new Date('2026-09-08T23:30:00Z'), windowOf(), LONDON)).toBe(false)
  })

  it('is outside all day on a Saturday', () => {
    expect(isInsideWindow(new Date('2026-09-05T10:00:00Z'), windowOf(), LONDON)).toBe(false)
  })

  it('treats the end of the window as exclusive, so nothing leaves at 17:00 on the dot', () => {
    const at17 = new Date('2026-09-08T16:00:00Z') // 17:00 London, BST
    expect(isInsideWindow(at17, windowOf(), LONDON)).toBe(false)
  })
})

describe('the next moment it may send', () => {
  it('is now, when now is inside the window', () => {
    const now = new Date('2026-09-08T09:00:00Z')
    expect(nextSlot(now, windowOf(), LONDON)?.toISOString()).toBe(now.toISOString())
  })

  it('is this morning at eight, when asked before the doors open', () => {
    // 05:00 London on a Tuesday.
    const early = new Date('2026-09-08T04:00:00Z')
    const slot = nextSlot(early, windowOf(), LONDON)
    expect(minutesOfDayIn(slot!, LONDON)).toBe(8 * 60)
    expect(slot!.toISOString().slice(0, 10)).toBe('2026-09-08')
  })

  it('is Monday morning, when asked on a Friday night', () => {
    // 2026-09-11 is a Friday; 22:00 London.
    const fridayNight = new Date('2026-09-11T21:00:00Z')
    const slot = nextSlot(fridayNight, windowOf(), LONDON)
    expect(slot).not.toBeNull()
    expect(minutesOfDayIn(slot!, LONDON)).toBe(8 * 60)
    // Monday the 14th, not Saturday the 12th.
    expect(slot!.toISOString().slice(0, 10)).toBe('2026-09-14')
  })

  it('steps over a skipped day as well as a weekend', () => {
    // Friday the 25th of December is skipped, so the next is Monday the 28th.
    const w = windowOf({ skipDates: ['2026-12-25'] })
    const thursdayNight = new Date('2026-12-24T20:00:00Z')
    const slot = nextSlot(thursdayNight, w, LONDON)
    expect(slot!.toISOString().slice(0, 10)).toBe('2026-12-28')
  })

  it('still means eight in the morning the week the clocks change', () => {
    // The clocks go back on 2026-10-25. The Monday after is still 08:00 London,
    // which is 08:00 UTC rather than the 07:00 UTC it was the week before.
    const before = nextSlot(new Date('2026-10-19T04:00:00Z'), windowOf(), LONDON)
    const after = nextSlot(new Date('2026-10-26T04:00:00Z'), windowOf(), LONDON)
    expect(before!.toISOString()).toBe('2026-10-19T07:00:00.000Z')
    expect(after!.toISOString()).toBe('2026-10-26T08:00:00.000Z')
    expect(minutesOfDayIn(before!, LONDON)).toBe(8 * 60)
    expect(minutesOfDayIn(after!, LONDON)).toBe(8 * 60)
  })

  it('gives up rather than spinning when nothing can ever satisfy it', () => {
    const never = windowOf({
      weekdaysOnly: true,
      skipDates: Array.from({ length: 800 }, (_, day) => addCalendarDays('2026-01-01', day)),
    })
    expect(nextSlot(new Date('2026-01-01T09:00:00Z'), never, LONDON)).toBeNull()
  })
})

describe('how many a day', () => {
  it('is the window divided by the gap', () => {
    // Nine hours at ninety seconds is 360.
    expect(slotsPerDay(windowOf())).toBe(360)
  })

  it('is capped when a cap is set', () => {
    expect(slotsPerDay(windowOf({ dailyCap: 100 }))).toBe(100)
  })

  it('doubles each day on a warm-up and never exceeds what the window allows', () => {
    const ramping = windowOf({ rampEnabled: true, rampStart: 50 })
    expect(rampCapForDay(1, ramping)).toBe(50)
    expect(rampCapForDay(2, ramping)).toBe(100)
    expect(rampCapForDay(3, ramping)).toBe(200)
    // 400 would be more than the window's own 360.
    expect(rampCapForDay(4, ramping)).toBe(360)
    // And a campaign left running for a year does not overflow back to a small
    // number, which is the bug a naive shift would produce.
    expect(rampCapForDay(400, ramping)).toBe(360)
  })

  it('is the plain daily cap when there is no warm-up', () => {
    expect(rampCapForDay(1, windowOf({ dailyCap: 25 }))).toBe(25)
    expect(rampCapForDay(1, windowOf())).toBeNull()
  })
})

describe('roughly when it finishes', () => {
  it('lands the same day when it fits in the day', () => {
    const start = new Date('2026-09-08T08:00:00Z')
    const finish = forecastFinish(10, windowOf(), LONDON, start)
    expect(finish!.toISOString().slice(0, 10)).toBe('2026-09-08')
  })

  it('runs into next week for a list that cannot fit in a week', () => {
    // 2000 at 360 a day is six sending days: Tuesday to the following Tuesday.
    const start = new Date('2026-09-08T07:00:00Z')
    const finish = forecastFinish(2000, windowOf(), LONDON, start)
    expect(finish).not.toBeNull()
    expect(finish!.getTime()).toBeGreaterThan(new Date('2026-09-14T00:00:00Z').getTime())
  })

  it('says nothing rather than lying when the pace is zero', () => {
    expect(forecastFinish(100, windowOf({ intervalSeconds: 3600, endMinute: 481 }), LONDON, new Date())).toBeNull()
  })

  it('is now for a list with nobody left on it', () => {
    const now = new Date('2026-09-08T09:00:00Z')
    expect(forecastFinish(0, windowOf(), LONDON, now)).toEqual(now)
  })
})

describe('the gap between messages', () => {
  it('is the interval when there is no jitter', () => {
    expect(gapAfterSend(windowOf(), 0.99)).toBe(90)
  })

  it('only ever adds - a campaign set to ninety never sends at eighty', () => {
    const jittery = windowOf({ jitterSeconds: 30 })
    expect(gapAfterSend(jittery, 0)).toBe(90)
    expect(gapAfterSend(jittery, 1)).toBe(120)
    expect(gapAfterSend(jittery, 0.5)).toBeGreaterThanOrEqual(90)
    expect(gapAfterSend(jittery, 0.5)).toBeLessThanOrEqual(120)
  })
})

describe('the small print', () => {
  it('reads a clock and writes one back', () => {
    expect(clockToMinute('08:00')).toBe(480)
    expect(clockToMinute('17:30')).toBe(1050)
    expect(clockToMinute('24:00')).toBe(1440)
    expect(clockToMinute('25:00')).toBeNull()
    expect(clockToMinute('half eight')).toBeNull()
    expect(minuteToClock(480)).toBe('08:00')
    expect(minuteToClock(1050)).toBe('17:30')
  })

  it('refuses a date that is not one', () => {
    expect(isCalendarDate('2026-12-25')).toBe(true)
    expect(isCalendarDate('2026-02-30')).toBe(false)
    expect(isCalendarDate('25/12/2026')).toBe(false)
  })

  it('counts days forward for a chase', () => {
    expect(daysAfter(new Date('2026-09-08T09:00:00Z'), 3).toISOString())
      .toBe('2026-09-11T09:00:00.000Z')
  })
})
