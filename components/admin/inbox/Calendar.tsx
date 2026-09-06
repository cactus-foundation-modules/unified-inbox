'use client'

import { useMemo, useState } from 'react'
import { calendarDateIn, formatInSiteTimezone, instantAtWallClock } from '@/lib/config/timezone'
import { ChevronLeftIcon, ChevronRightIcon } from './icons'

// A month and two boxes, for the one answer the ready-made times never cover:
// "the morning they said they would ring back".
//
// Lifted out of the snooze menu when a second menu needed exactly the same
// thing. Putting a conversation to sleep and setting a reply to go out later
// are the same question - which day, and what time - and two calendars would be
// two places for a month to be drawn a day out.
//
// Every time in here is the SITE's, not the browser's. Somebody answering
// Deskwell's inbox from Spain who picks nine o'clock means nine o'clock in
// Kent, and `new Date('2026-09-07T09:00')` - which is what a datetime-local box
// gives - would have meant eight.

/** Monday first. This is a British site and a week that starts on Sunday reads
 *  as somebody else's calendar. */
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
/** Six rows of seven always drawn, so the panel does not change height as the
 *  months are walked - a menu that grows and shrinks under the cursor moves the
 *  thing being aimed at. */
const CELLS = 42
/** What a day gets when it is picked and no time has been said yet. The same
 *  hour every "morning" in either menu means. */
const DEFAULT_TIME = '09:00'

/** "YYYY-MM-DD", from the parts of a calendar rather than from an instant.
 *  Going through a Date here is how a calendar ends up a day out. */
function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

type Cell = { key: string; iso: string; day: number; inMonth: boolean }

/** The six weeks a month is drawn over, starting on the Monday on or before the
 *  first, with the days either side of it kept and greyed - a month drawn with
 *  holes in the corners is harder to read than one with its neighbours in. */
function monthCells(year: number, month: number): Cell[] {
  const first = new Date(year, month, 1)
  // getDay is Sunday-first; this is the number of days back to the Monday.
  const back = (first.getDay() + 6) % 7
  const cells: Cell[] = []
  for (let i = 0; i < CELLS; i++) {
    const at = new Date(year, month, 1 - back + i)
    cells.push({
      key: `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`,
      iso: isoDate(at.getFullYear(), at.getMonth(), at.getDate()),
      day: at.getDate(),
      inMonth: at.getMonth() === month,
    })
  }
  return cells
}

/** The day and time a choice lands on, said the way the menus say everything
 *  else: today by the clock, anything further off by the date. */
export function landsOn(until: Date, now: Date, timezone: string): string {
  const time = formatInSiteTimezone(until, timezone, { hour: '2-digit', minute: '2-digit' })
  if (calendarDateIn(until, timezone) === calendarDateIn(now, timezone)) return `Today, ${time}`
  const day = formatInSiteTimezone(until, timezone, { weekday: 'short', day: 'numeric', month: 'short' })
  return `${day}, ${time}`
}

type Props = {
  /** What the panel is called, on the line with the way back on it. */
  title: string
  timezone: string
  busy: boolean
  /** What the button that takes the answer says: "Snooze", "Send it then". */
  confirmLabel: string
  /** Back to the ready-made times the calendar was opened from. */
  onBack: () => void
  /** Shut the whole menu without choosing anything. */
  onCancel: () => void
  /** A real moment, in the future, in the site's zone. Checked here so nothing
   *  downstream has to be told twice. */
  onConfirm: (at: Date) => void
}

export function TimeCalendar({
  title, timezone, busy, confirmLabel, onBack, onCancel, onConfirm,
}: Props) {
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [error, setError] = useState('')

  // Read once, when the panel opens, rather than on every keystroke: which day
  // is "today" must not quietly change under somebody's cursor at midnight.
  const now = useMemo(() => new Date(), [])
  const today = useMemo(() => calendarDateIn(now, timezone), [now, timezone])

  const [shown, setShown] = useState(() => {
    const [year, month] = today.split('-').map(Number)
    return { year: year ?? now.getFullYear(), month: (month ?? 1) - 1 }
  })
  const cells = useMemo(() => monthCells(shown.year, shown.month), [shown])

  const shiftMonth = (by: number) => setShown(({ year, month }) => {
    const at = new Date(year, month + by, 1)
    return { year: at.getFullYear(), month: at.getMonth() }
  })

  const confirm = () => {
    if (!date || !time) {
      setError('Pick a day and a time.')
      return
    }
    const at = instantAtWallClock(date, time, timezone)
    if (Number.isNaN(at.getTime())) {
      setError('That is not a time this can read.')
      return
    }
    if (at.getTime() <= Date.now()) {
      setError('Pick a time that has not happened yet.')
      return
    }
    setError('')
    onConfirm(at)
  }

  return (
    <div className="uin-cal">
      <div className="uin-menu-title uin-cal-title">
        <button
          type="button"
          className="uin-icon-btn"
          aria-label="Back to the ready-made times"
          onClick={onBack}
        >
          {ChevronLeftIcon}
        </button>
        <span>{title}</span>
      </div>

      <div className="uin-cal-month">
        <button type="button" className="uin-icon-btn" aria-label="The month before" onClick={() => shiftMonth(-1)}>
          {ChevronLeftIcon}
        </button>
        {/* Named from the calendar's own numbers, NOT by formatting a Date in
            the site's zone: midnight on the first, read in a zone a few hours
            behind, is the last day of the month before - which would have put
            "August 2026" over a grid of September. */}
        <span aria-live="polite">{MONTHS[shown.month]} {shown.year}</span>
        <button type="button" className="uin-icon-btn" aria-label="The month after" onClick={() => shiftMonth(1)}>
          {ChevronRightIcon}
        </button>
      </div>

      <div className="uin-cal-grid" role="group" aria-label="Pick a day">
        {WEEKDAYS.map((day) => (
          <span key={day} className="uin-cal-weekday" aria-hidden="true">{day}</span>
        ))}
        {cells.map((cell) => (
          <button
            key={cell.key}
            type="button"
            className="uin-cal-day"
            data-outside={cell.inMonth ? undefined : '1'}
            data-today={cell.iso === today ? '1' : undefined}
            aria-pressed={cell.iso === date}
            // A day that has already been is not a day anything can happen on,
            // and greying it out says so before the button is pressed.
            disabled={busy || cell.iso < today}
            onClick={() => {
              setDate(cell.iso)
              // A day with no hour against it cannot be used, and making
              // somebody type nine o'clock every time is a step with no
              // question in it.
              setTime((was) => was || DEFAULT_TIME)
              setError('')
            }}
          >
            {cell.day}
          </button>
        ))}
      </div>

      <div className="uin-cal-fields">
        <label className="uin-cal-field">
          <span>Date</span>
          <input
            type="date"
            value={date}
            min={today}
            disabled={busy}
            onChange={(event) => {
              setDate(event.target.value)
              setError('')
              // Typed rather than picked, so the month behind it follows along.
              const [year, month] = event.target.value.split('-').map(Number)
              if (year && month) setShown({ year, month: month - 1 })
            }}
          />
        </label>
        <label className="uin-cal-field">
          <span>Time</span>
          <input
            type="time"
            value={time}
            disabled={busy}
            onChange={(event) => { setTime(event.target.value); setError('') }}
          />
        </label>
      </div>

      {error && <p className="uin-cal-error" role="alert">{error}</p>}

      <div className="uin-cal-buttons">
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy || !date || !time}
          onClick={confirm}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  )
}
