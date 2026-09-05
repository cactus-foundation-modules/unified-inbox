import { calendarDateIn, formatInSiteTimezone, instantAtWallClock } from '@/lib/config/timezone'
import type { SendWindow } from './types'

// ---------------------------------------------------------------------------
// The clock.
//
// Every decision about WHEN a campaign message may leave is in this file, and
// none of it touches the database, so all of it is a test rather than a
// memory. Three things go wrong quietly here, and each one is answered below.
//
// 08:00 MEANS 08:00 IN THE SITE'S ZONE. Not on the machine, which keeps UTC,
// and not at a fixed offset from it either: a campaign set up in February and
// still running in April must send at eight in the morning both times, and an
// offset stored in October is an hour out by Christmas. So every boundary is
// worked out from wall clock through the site's own zone, exactly as the
// composer's "send later" box is.
//
// A DAY THAT IS NOT A SENDING DAY IS SKIPPED WHOLE. Weekends when the campaign
// says weekdays, and whatever dates somebody has listed - Christmas, the August
// bank holiday, the week the office is shut. The search walks forward day by
// day rather than adding twenty-four hours, because adding twenty-four hours to
// 08:00 the day the clocks go back lands at 07:00.
//
// THE PACE IS A FLOOR, NOT A PROMISE. What comes back is the earliest moment a
// message MAY go. What actually sends it is a tick that arrives when it
// arrives - a browser with the screen open, the hourly round, or whatever the
// site has pointed at the tick address - so everything downstream says "on or
// after" and never promises the minute.
// ---------------------------------------------------------------------------

/** How far the search will walk looking for the next day it may send on. Two
 *  years, which is longer than any plausible run of skipped days and short
 *  enough that a campaign configured to never send at all returns rather than
 *  spinning. */
const MAX_DAYS_AHEAD = 730

const DAY_MS = 86_400_000

/** The sensible defaults a new campaign opens with: office hours, weekdays, a
 *  minute and a half between messages. */
export const DEFAULT_WINDOW: SendWindow = {
  startMinute: 8 * 60,
  endMinute: 17 * 60,
  weekdaysOnly: true,
  skipDates: [],
  intervalSeconds: 90,
  jitterSeconds: 0,
  dailyCap: null,
  rampEnabled: false,
  rampStart: 50,
}

/** "YYYY-MM-DD" as the day of the week, 0 for Sunday. Parsed as UTC on purpose:
 *  the string already IS the site's own calendar date, so the machine's zone
 *  must not get a second vote on which day it names. */
export function weekdayOfCalendarDate(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay()
}

/** The calendar date `days` days after this one, still "YYYY-MM-DD". */
export function addCalendarDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const shifted = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days))
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(shifted)
}

/** Whether this campaign sends at all on that calendar date. */
export function isSendingDay(day: string, window: SendWindow): boolean {
  if (window.skipDates.includes(day)) return false
  if (!window.weekdaysOnly) return true
  const weekday = weekdayOfCalendarDate(day)
  return weekday >= 1 && weekday <= 5
}

/** Minutes past midnight, site time, that an instant falls at. */
export function minutesOfDayIn(at: Date, timezone: string): number {
  const clock = formatInSiteTimezone(at, timezone, {
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const [hh, mm] = clock.split(':').map(Number)
  // Midnight comes back as "24:00" in one or two runtimes, which is the same
  // instant said the long way round.
  const hours = hh === 24 ? 0 : (hh ?? 0)
  return hours * 60 + (mm ?? 0)
}

/** The instant a minutes-past-midnight lands at on a calendar date. */
function instantAt(day: string, minute: number, timezone: string): Date {
  const hh = String(Math.floor(minute / 60)).padStart(2, '0')
  const mm = String(minute % 60).padStart(2, '0')
  return instantAtWallClock(day, `${hh}:${mm}`, timezone)
}

/** Whether a moment is inside the window on a day the campaign sends on. */
export function isInsideWindow(at: Date, window: SendWindow, timezone: string): boolean {
  const day = calendarDateIn(at, timezone)
  if (!isSendingDay(day, window)) return false
  const minute = minutesOfDayIn(at, timezone)
  return minute >= window.startMinute && minute < window.endMinute
}

/**
 * The first moment at or after `from` that this campaign may send.
 *
 * Inside the window on a sending day, that is `from` itself - the campaign is
 * already due and the caller was only checking. Otherwise it is the start of
 * the window on the next day it sends on, which may be tomorrow, may be Monday,
 * and may be the fifth of January.
 *
 * Null only for a campaign whose window nothing can satisfy, which means
 * somebody has listed two years of skip dates. Better than a loop.
 */
export function nextSlot(from: Date, window: SendWindow, timezone: string): Date | null {
  let day = calendarDateIn(from, timezone)
  const minute = minutesOfDayIn(from, timezone)

  for (let step = 0; step <= MAX_DAYS_AHEAD; step++) {
    if (isSendingDay(day, window)) {
      // Today, and we are before the doors open.
      if (step === 0 && minute < window.startMinute) return instantAt(day, window.startMinute, timezone)
      // Today, and we are inside them: now is the answer.
      if (step === 0 && minute < window.endMinute) return from
      // Any later day starts at the top of the window.
      if (step > 0) return instantAt(day, window.startMinute, timezone)
    }
    day = addCalendarDays(day, 1)
  }
  return null
}

/**
 * How many messages a day this window is worth.
 *
 * The window's own length divided by the gap, then whatever ceiling the
 * campaign has put on top. Used for the finish-date forecast and for the daily
 * cap, so both are answered by the same arithmetic rather than by two guesses
 * that disagree on the screen.
 */
export function slotsPerDay(window: SendWindow): number {
  const minutes = Math.max(0, window.endMinute - window.startMinute)
  const perDay = Math.floor((minutes * 60) / Math.max(1, window.intervalSeconds))
  return window.dailyCap ? Math.min(perDay, window.dailyCap) : perDay
}

/**
 * The ceiling for one sending day of a warm-up.
 *
 * `dayNumber` counts the days this campaign has actually sent on, from one. The
 * ramp doubles each of those days until it passes what the window could manage
 * anyway, at which point it stops being the limit. A domain that normally sends
 * five emails a day and starts sending three hundred is a domain that gets
 * noticed; fifty, a hundred, two hundred, then whatever the window allows, is
 * not.
 */
export function rampCapForDay(dayNumber: number, window: SendWindow): number | null {
  if (!window.rampEnabled) return window.dailyCap
  const doublings = Math.max(0, dayNumber - 1)
  // Capped before the shift so a campaign left running for a year does not
  // overflow its way back to a small number.
  const ramp = doublings >= 20 ? Number.MAX_SAFE_INTEGER : window.rampStart * 2 ** doublings
  const ceiling = window.dailyCap ? Math.min(ramp, window.dailyCap) : ramp
  return Math.min(ceiling, slotsPerDay(window))
}

/**
 * Roughly when the last one goes out.
 *
 * Deliberately "roughly", and said that way on the screen: it counts sending
 * days at the day's own ceiling and takes no account of a tick that does not
 * arrive, a mail service having a bad afternoon, or the chases that follow. It
 * is the answer to "am I looking at three days or three weeks", which is the
 * question somebody actually has before they press start.
 */
export function forecastFinish(
  remaining: number,
  window: SendWindow,
  timezone: string,
  from: Date,
): Date | null {
  if (remaining <= 0) return from
  const perDay = slotsPerDay(window)
  if (perDay <= 0) return null

  let left = remaining
  let day = calendarDateIn(from, timezone)
  let sendingDay = 0
  // The first day only has whatever is left of its window.
  let firstDayAllowance = perDay
  if (isSendingDay(day, window)) {
    const minute = minutesOfDayIn(from, timezone)
    const minutesLeft = Math.max(0, window.endMinute - Math.max(minute, window.startMinute))
    firstDayAllowance = Math.floor((minutesLeft * 60) / Math.max(1, window.intervalSeconds))
    if (window.dailyCap) firstDayAllowance = Math.min(firstDayAllowance, window.dailyCap)
  }

  for (let step = 0; step <= MAX_DAYS_AHEAD; step++) {
    if (isSendingDay(day, window)) {
      sendingDay += 1
      const ceiling = rampCapForDay(sendingDay, window) ?? perDay
      const allowance = step === 0 ? Math.min(firstDayAllowance, ceiling) : ceiling
      if (allowance >= left) {
        // Lands part way through this day's window: the start of it plus
        // however many gaps are still to come.
        const startMinute = step === 0
          ? Math.max(minutesOfDayIn(from, timezone), window.startMinute)
          : window.startMinute
        const seconds = Math.max(0, left - 1) * window.intervalSeconds
        const at = instantAt(day, startMinute, timezone).getTime() + seconds * 1000
        return new Date(at)
      }
      left -= allowance
    }
    day = addCalendarDays(day, 1)
  }
  return null
}

/**
 * The gap to leave after a message has gone, jitter and all.
 *
 * `random` is passed in rather than read off Math.random so the awkward cases
 * are a test rather than a hope. Jitter only ever ADDS: a campaign set to
 * ninety seconds must never send at eighty.
 */
export function gapAfterSend(window: SendWindow, random: number = Math.random()): number {
  const jitter = Math.floor(Math.max(0, Math.min(1, random)) * (window.jitterSeconds + 1))
  return window.intervalSeconds + Math.min(jitter, window.jitterSeconds)
}

/** Minutes past midnight as "08:00", for the boxes on the screen. */
export function minuteToClock(minute: number): string {
  const hh = String(Math.floor(minute / 60) % 24).padStart(2, '0')
  const mm = String(minute % 60).padStart(2, '0')
  return `${hh}:${mm}`
}

/** "08:00" back to minutes past midnight, or null for anything else. */
export function clockToMinute(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hh = Number(match[1])
  const mm = Number(match[2])
  if (hh > 24 || mm > 59 || (hh === 24 && mm !== 0)) return null
  return hh * 60 + mm
}

/** The window said the way somebody would say it, for the summary line above
 *  the start button. */
export function describeWindow(window: SendWindow): string {
  const days = window.weekdaysOnly ? 'weekdays' : 'every day'
  const gap = window.intervalSeconds % 60 === 0
    ? `${window.intervalSeconds / 60} minute${window.intervalSeconds === 60 ? '' : 's'}`
    : `${window.intervalSeconds} seconds`
  return `${minuteToClock(window.startMinute)} to ${minuteToClock(window.endMinute)}, ${days}, one every ${gap}`
}

/** Whether a calendar date is one this understands. The skip list is typed by
 *  hand often enough to be worth refusing rather than ignoring. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const date = new Date(Date.UTC(y!, m! - 1, d!))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m! - 1 && date.getUTCDate() === d
}

/** The whole days between two instants, for the chase that is due `n` days
 *  after the last message went. Counted in milliseconds rather than in calendar
 *  days: "three days later" from a Friday afternoon is Monday afternoon, and
 *  the window pushes it to Monday morning's opening if it has to. */
export function daysAfter(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS)
}
