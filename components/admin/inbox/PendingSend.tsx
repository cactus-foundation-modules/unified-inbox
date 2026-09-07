'use client'

import { describeSendAt } from '@/modules/unified-inbox/lib/scheduled'

// A time somebody has picked off the alarm clock and has not committed yet.
//
// It sits above the buttons that commit it, because picking a time and deciding
// what that time MEANS - just send it then, or send it then and put the
// conversation to sleep - are the same moment's thinking. A menu that saved on
// the first click would have had to guess which of the two was meant.
//
// It says the time and offers the way back out, and that is all it does. There
// used to be a chase here as well - "bring this back if nobody replies" - which
// took the place of the Send & snooze button whenever a time was picked, so
// choosing to send later quietly cost you the ability to put the conversation
// to sleep. Two ways of arranging the same afternoon, one of them hidden behind
// the other. The button stays now, and says "Send later & snooze".

type Props = {
  /** When it is set to go. */
  at: Date
  /** Take the time back off and go back to sending it now. */
  onClear: () => void
  timezone: string
  busy: boolean
}

export function PendingSend({ at, onClear, timezone, busy }: Props) {
  const now = new Date()

  return (
    <div className="uin-composer-row uin-pending-send">
      <span className="uin-recipients">Set to go out {describeSendAt(at, now, timezone)}.</span>
      <button type="button" className="uin-chip" disabled={busy} onClick={onClear}>
        Cancel send later
      </button>
    </div>
  )
}
