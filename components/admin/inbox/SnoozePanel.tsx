'use client'

import { useMemo, useState } from 'react'
import { snoozeOptions } from '@/modules/unified-inbox/lib/list'
import { MenuItem, useDropdownClose } from './Dropdown'
import { TimeCalendar, landsOn } from './Calendar'
import { ChevronRightIcon } from './icons'

// When a conversation comes back.
//
// The ready-made answers cover most of it, each with the day and time it
// actually lands on written beside it - "Tomorrow morning" is a promise, and a
// promise with no time against it is one people check by making it and then
// undoing it. What none of them covers is "the morning they said they would
// ring back", so the last entry opens the shared month and its two boxes.
//
// The same panel serves three buttons now: the clock on the conversation, Send
// & snooze under the reply box, and Send later & snooze beside it. All three
// are asking one question - when should this come back - and answering it three
// different ways would be three vocabularies for one idea. What differs is only
// what happens either side of the answer, which is the caller's business.
//
// Every time in here is the SITE's, not the browser's - see Calendar.tsx.

type Props = {
  /** Where the conversation stands, so a snoozed one can also be brought back.
   *  Left out where the panel is not being used to change a conversation's own
   *  state - sending and then snoozing has nothing to bring back yet. */
  status?: string
  timezone: string
  busy: boolean
  /** What the panel calls itself. The plain menu says "Snooze"; the two that
   *  send first say what they are about to do, because the times underneath
   *  read very differently when a message goes out with them. */
  title?: string
  /** Put it to sleep until then. The panel has already checked it is a real
   *  moment and that it has not happened yet. */
  onSnooze: (until: Date) => void
  /** Bring it back now, off a snooze. Only ever offered when `status` says it
   *  is asleep. */
  onWake?: () => void
}

export function SnoozePanel({ status, timezone, busy, title = 'Snooze', onSnooze, onWake }: Props) {
  const close = useDropdownClose()
  // Whether the month is showing. The ready-made answers are what this is
  // opened for, so they are what it opens on.
  const [picking, setPicking] = useState(false)

  // Read once, when the panel opens, rather than on every keystroke: the menu
  // saying "Today, 18:00" must not quietly become "Today, 18:01" while
  // somebody reads it. Nothing here is server-rendered - the panel only exists
  // after a press - so there is no clock to disagree with.
  const now = useMemo(() => new Date(), [])
  const options = useMemo(() => snoozeOptions(now, timezone), [now, timezone])

  if (!picking) {
    return (
      <>
        <div className="uin-menu-title">{title}</div>
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
        {status === 'snoozed' && onWake && (
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
    <TimeCalendar
      title={title}
      timezone={timezone}
      busy={busy}
      confirmLabel="Snooze"
      onBack={() => setPicking(false)}
      onCancel={close}
      onConfirm={(until) => {
        // Shut on the way, the way the ready-made answers do. Anything the
        // server refuses is said in the row of actions underneath rather than
        // inside a panel nobody is looking at any more.
        close()
        onSnooze(until)
      }}
    />
  )
}
