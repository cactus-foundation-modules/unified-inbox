'use client'

import { useMemo, useState } from 'react'
import { snoozeOptions } from '@/modules/unified-inbox/lib/list'
import { MenuItem, useDropdownClose } from './Dropdown'
import { TimeCalendar, landsOn } from './Calendar'
import { ChevronRightIcon } from './icons'

// When a reply goes out, behind the alarm clock under the writing box.
//
// The same menu, in the same words, as putting the conversation to sleep -
// deliberately. "Bring this back on Thursday morning" and "send this on
// Thursday morning" are one shape of decision, and a date-and-time box beside a
// menu of ready-made times was two vocabularies for it. The one that reads like
// a form has gone; this reads like the clock beside it.
//
// Picking a time here does not send anything and does not save anything. It
// puts a time in front of somebody, and the two buttons that appear underneath
// are what commit it - because "send it later" and "send it later and put this
// conversation to sleep until then" are different instructions, and a menu that
// guessed which one was meant would be wrong half the time.

type Props = {
  timezone: string
  busy: boolean
  /** Whether a departure time is already set on this message, so the way to
   *  take it back off is on the same menu that put it there. */
  scheduled: boolean
  /** A real moment, in the future, in the site's zone. */
  onPick: (at: Date) => void
  onCancelTimer: () => void
}

export function SendLaterPanel({ timezone, busy, scheduled, onPick, onCancelTimer }: Props) {
  const close = useDropdownClose()
  const [picking, setPicking] = useState(false)

  // Read once, when the panel opens: the menu saying "Today, 18:00" must not
  // quietly become "Today, 18:01" while somebody reads it.
  const now = useMemo(() => new Date(), [])
  const options = useMemo(() => snoozeOptions(now, timezone), [now, timezone])

  if (!picking) {
    return (
      <>
        <div className="uin-menu-title">Send it later</div>
        {options.map((option) => (
          <MenuItem
            key={option.id}
            disabled={busy}
            hint={landsOn(option.until, now, timezone)}
            onClick={() => onPick(option.until)}
          >
            {option.label}
          </MenuItem>
        ))}
        {scheduled && (
          <MenuItem disabled={busy} onClick={onCancelTimer}>Cancel the timer</MenuItem>
        )}
        <div className="uin-menu-sep" />
        <MenuItem keepOpen disabled={busy} after={ChevronRightIcon} onClick={() => setPicking(true)}>
          Day &amp; Time
        </MenuItem>
      </>
    )
  }

  return (
    <TimeCalendar
      title="Send it later"
      timezone={timezone}
      busy={busy}
      confirmLabel="Use that time"
      onBack={() => setPicking(false)}
      onCancel={close}
      onConfirm={(at) => { close(); onPick(at) }}
    />
  )
}
