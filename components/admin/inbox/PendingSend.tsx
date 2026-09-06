'use client'

import { describeSendAt, followUpMinutesBetween, followUpOptions, MIN_FOLLOW_UP_MINUTES } from '@/modules/unified-inbox/lib/scheduled'
import { Dropdown, MenuItem } from './Dropdown'

// A time somebody has picked off the alarm clock and has not committed yet.
//
// It sits above the buttons that commit it, because picking a time and deciding
// what that time MEANS - just send it then, send it then and put the
// conversation to sleep, send it then and chase it if nobody answers - are the
// same moment's thinking. A menu that saved on the first click would have had
// to guess which of the three was meant.
//
// The chase is here rather than behind another button for the same reason it
// used to sit beside the date box: whether to chase it is part of the thought,
// and a chase nobody was offered is a chase nobody sets. It is the same three
// answers, in the same words, that putting a conversation to sleep offers -
// counted from when the message LEAVES rather than from now, because "tomorrow
// morning" for a message going out on Friday night is Saturday morning.

type Props = {
  /** When it is set to go. */
  at: Date
  /** How long after that to bring the conversation back, or null for never. */
  followUp: number | null
  onFollowUp: (minutes: number | null) => void
  /** Said when somebody picks a chase that would happen before the message. */
  onProblem: (message: string) => void
  /** Take the time back off and go back to sending it now. */
  onClear: () => void
  timezone: string
  busy: boolean
}

export function PendingSend({ at, followUp, onFollowUp, onProblem, onClear, timezone, busy }: Props) {
  const now = new Date()
  const choices = followUpOptions(at, timezone)
  const chaseAt = followUp !== null ? new Date(at.getTime() + followUp * 60_000) : null

  const choose = (until: Date) => {
    const minutes = followUpMinutesBetween(at, until)
    if (minutes < MIN_FOLLOW_UP_MINUTES) {
      onProblem('Pick a time after the message has gone, not before it.')
      return
    }
    onFollowUp(minutes)
  }

  return (
    <div className="uin-composer-row uin-pending-send">
      <span className="uin-recipients">Set to go out {describeSendAt(at, now, timezone)}.</span>
      {/* The chase, and no longer a pill saying "No chase".
          A pill is a thing that has been set, and that one stood on every
          message with a time on it announcing what had NOT been set - so it read
          as a state somebody had chosen rather than an offer. It is the same
          menu, worded as the offer it is and drawn as one of the small links the
          composer uses for Cc and Bcc; once a chase exists it says so. */}
      <Dropdown
        className={chaseAt ? 'uin-chip' : 'uin-field-add'}
        label={chaseAt
          ? `Chase it ${describeSendAt(chaseAt, now, timezone)}`
          : 'Chase it if nobody replies'}
        width={260}
        disabled={busy}
      >
        <div className="uin-menu-title">Bring it back if nobody replies</div>
        <MenuItem disabled={busy} onClick={() => onFollowUp(null)}>Leave it</MenuItem>
        {choices.map((choice) => (
          <MenuItem
            key={choice.id}
            disabled={busy}
            hint={describeSendAt(choice.until, now, timezone)}
            onClick={() => choose(choice.until)}
          >
            {choice.label}
          </MenuItem>
        ))}
      </Dropdown>
      <button type="button" className="uin-chip" disabled={busy} onClick={onClear}>
        Cancel send later
      </button>
    </div>
  )
}
