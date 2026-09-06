'use client'

import { useMemo, useState } from 'react'
import { calendarDateIn, formatInSiteTimezone, instantAtWallClock } from '@/lib/config/timezone'
import { snoozeOptions } from '@/modules/unified-inbox/lib/list'
import { MenuItem, useDropdownClose } from './Dropdown'
import { ChevronLeftIcon, ChevronRightIcon } from './icons'

// When a conversation comes back.
//
// The ready-made answers cover most of it, each with the day and time it
// actually lands on written beside it - "Tomorrow morning" is a promise, and a
// promise with no time against it is one people check by making it and then
// undoing it. What none of them covers is "the morning they said they would
// ring back", so the last entry opens a month and two boxes.
//
// Every time in here is the SITE's, not the browser's. Somebody answering
// Deskwell's inbox from Spain who picks nine o'clock means nine o'clock in
// Kent, and `new Date('2026-09-07T09:00')` - which is what the old
// datetime-local box did - would have meant eight.

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
 *  hour every other "morning" in here means. */
const DEFAULT_TIME = '09:00'

type Props = {
  /** Where the conversation stands, so a snoozed one can also be brought back. */
  status: string
  timezone: string
  busy: boolean
  /** Put it to sleep until then. The panel has already checked it is a real
   *  moment and that it has not happened yet. */
  onSnooze: (until: Date) => void
  /** Bring it back now, off a snooze. */
  onWake: () => void
}

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

/** The day and time a snooze lands on, said the way the menu it sits in says
 *  everything else: today by the clock, anything further off by the date. */
function landsOn(until: Date, now: Date, timezone: string): string {
  const time = formatInSiteTimezone(until, timezone, { hour: '2-digit', minute: '2-digit' })
  if (calendarDateIn(until, timezone) === calendarDateIn(now, timezone)) return `Today, ${time}`
  const day = formatInSiteTimezone(until, timezone, { weekday: 'short', day: 'numeric', month: 'short' })
  return `${day}, ${time}`
}

export function SnoozePanel({ status, timezone, busy, onSnooze, onWake }: Props) {
  const close = useDropdownClose()
  // Whether the month is showing. The ready-made answers are what this is
  // opened for, so they are what it opens on.
  const [picking, setPicking] = useState(false)
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [error, setError] = useState('')

  // Read once, when the panel opens, rather than on every keystroke: the menu
  // saying "Today, 18:00" must not quietly become "Today, 18:01" while
  // somebody reads it. Nothing here is server-rendered - the panel only exists
  // after a press - so there is no clock to disagree with.
  const now = useMemo(() => new Date(), [])
  const options = useMemo(() => snoozeOptions(now, timezone), [now, timezone])
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
    const until = instantAtWallClock(date, time, timezone)
    if (Number.isNaN(until.getTime())) {
      setError('That is not a time this can read.')
      return
    }
    if (until.getTime() <= Date.now()) {
      setError('Pick a time that has not happened yet.')
      return
    }
    setError('')
    // Shut on the way, the way the ready-made answers do. Anything the server
    // refuses is said in the row of actions underneath rather than inside a
    // panel nobody is looking at any more.
    close()
    onSnooze(until)
  }

  if (!picking) {
    return (
      <>
        <div className="uin-menu-title">Snooze</div>
        {options.map((option) => (
          <MenuItem
            key={option.id}
            disabled={busy}
            hint={landsOn(option.until, now, timezone)}
            onClick={() => onSnooze(option.until)}
          >
            {option.label}
          </MenuItem>
        ))}
        {status === 'snoozed' && (
          <MenuItem disabled={busy} onClick={onWake}>Bring it back now</MenuItem>
        )}
        <div className="uin-menu-sep" />
        {/* The one entry that chooses nothing: the panel stays open and swaps
            what is in it, which is what the chevron on the right is
            promising. */}
        <MenuItem keepOpen disabled={busy} after={ChevronRightIcon} onClick={() => setPicking(true)}>
          Day &amp; Time
        </MenuItem>
      </>
    )
  }

  return (
    <div className="uin-cal">
      <div className="uin-menu-title uin-cal-title">
        <button
          type="button"
          className="uin-icon-btn"
          aria-label="Back to the ready-made times"
          onClick={() => setPicking(false)}
        >
          {ChevronLeftIcon}
        </button>
        <span>Snooze</span>
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
            // A day that has already been is not a day something can come back
            // on, and greying it out says so before the button is pressed.
            disabled={busy || cell.iso < today}
            onClick={() => {
              setDate(cell.iso)
              // A day with no hour against it cannot be snoozed to, and making
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
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy || !date || !time}
          onClick={confirm}
        >
          Snooze
        </button>
      </div>
    </div>
  )
}
