'use client'

import { useState } from 'react'
import { describeSendAt } from '@/modules/unified-inbox/lib/scheduled'
import type { DraftSendState } from '@/modules/unified-inbox/lib/types'

// Send it later: the control both composers share.
//
// It is deliberately the same shape in the reply box and in the new-message
// dialog, because it is the same decision in both - the message is written,
// and the only question left is whether it goes now or at some hour that suits
// the person receiving it better than half past eleven at night does.
//
// The box is a plain date and time with no zone on it, and what is typed is
// what is meant: nine o'clock is nine o'clock as the site tells the time. That
// is settled on the server (lib/scheduled.ts), which is also where a time in
// the past or a year that is plainly a typo is refused - so nothing here has to
// be trusted, and the earliest value the box will take is handed in already
// worked out in the site's own zone.
//
// A scheduled message is still a draft, sitting under Drafts with a time on it,
// which is what makes every other question about it - who may read it, who may
// finish it, what happens when the address is deleted - one that was already
// answered.

type Props = {
  /** When it is set to go, as an ISO stamp, or null while it is not set. */
  sendAt: string | null
  sendState: DraftSendState
  /** Why the last attempt was refused, when there was one. */
  sendError: string | null
  /** The earliest the box will take, in its own "YYYY-MM-DDTHH:MM" shape,
   *  worked out on the server in the site's zone. */
  minWallClock: string
  /** What it says when it is set, and what the box means, both belong to the
   *  site's zone rather than to whichever one this browser is standing in. */
  timezone: string
  busy: boolean
  /** Whether anything can be sent at all - the same test the Send button makes.
   *  A timer on a message that cannot be sent is a promise nobody can keep. */
  disabled?: boolean
  onSchedule: (wallClock: string) => void
  onCancel: () => void
}

export function SendLater({
  sendAt, sendState, sendError, minWallClock, timezone, busy, disabled, onSchedule, onCancel,
}: Props) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(minWallClock)
  const [problem, setProblem] = useState('')

  const scheduled = sendState === 'scheduled' || sendState === 'sending'

  const schedule = () => {
    if (!value) {
      setProblem('Pick the day and the time it should go out.')
      return
    }
    setProblem('')
    setOpen(false)
    onSchedule(value)
  }

  return (
    <div className="uin-sendlater">
      {sendState === 'failed' && (
        <div className="alert alert-danger" role="alert">
          This one did not go out.{sendError ? ` ${sendError}` : ''} It is still here, so you can
          fix it and send it or set another time.
        </div>
      )}

      {scheduled && (
        <div className="alert alert-info" role="status">
          {sendState === 'sending'
            ? 'This one is going out now.'
            : `This is set to go out ${describeSendAt(sendAt, new Date(), timezone)}. It leaves on its own - you do not have to be here.`}
        </div>
      )}

      <div className="uin-composer-row">
        {!open && (
          <button
            type="button"
            className="uin-chip"
            aria-pressed={scheduled}
            disabled={busy || disabled}
            onClick={() => { setValue(sendAt ? minWallClock : value || minWallClock); setOpen(true) }}
          >
            {scheduled ? 'Change when it goes' : 'Send it later'}
          </button>
        )}
        {scheduled && !open && (
          <button type="button" className="uin-chip" disabled={busy} onClick={onCancel}>
            Cancel the timer
          </button>
        )}
      </div>

      {open && (
        <div className="uin-sendlater-picker">
          <div className="field">
            <label htmlFor="uin-send-at">Send it on</label>
            <input
              id="uin-send-at"
              type="datetime-local"
              value={value}
              min={minWallClock}
              onChange={(e) => { setValue(e.target.value); setProblem('') }}
            />
            {/* Said out loud rather than implied. The site checks for mail and
                sends what is waiting on a schedule of its own, so a message set
                for 09:30 goes at 09:30 or shortly after - never before. */}
            <span className="uin-field-hint">
              It goes out at that time or shortly after, and never before it.
            </span>
          </div>
          {problem && <div className="alert alert-danger" role="alert">{problem}</div>}
          <div className="uin-composer-row">
            <button type="button" className="btn btn-primary btn-sm" onClick={schedule} disabled={busy}>
              {scheduled ? 'Move it to then' : 'Schedule it'}
            </button>
            <button
              type="button"
              className="uin-chip"
              onClick={() => { setOpen(false); setProblem('') }}
              disabled={busy}
            >
              Never mind
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
