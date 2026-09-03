'use client'

import { useState } from 'react'
import { instantAtWallClock } from '@/lib/config/timezone'
import {
  describeSendAt,
  followUpMinutesBetween,
  followUpOptions,
  MIN_FOLLOW_UP_MINUTES,
} from '@/modules/unified-inbox/lib/scheduled'
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
//
// The second half of the panel is the chase: how long to wait for an answer
// before the conversation comes back. It is set at the same moment as the time,
// because that is the moment somebody is thinking about the message leaving,
// and it rides with the time - cancelling the timer cancels the chase, which is
// why there is no second button for it.
//
// A message can also be stood down without anybody touching this panel: mail
// from the person it was addressed to takes the time off, keeps the writing and
// says so here, so that nobody sends an answer to a question that has already
// been answered.

type Props = {
  /** When it is set to go, as an ISO stamp, or null while it is not set. */
  sendAt: string | null
  sendState: DraftSendState
  /** Why the last attempt was refused, when there was one. */
  sendError: string | null
  /** How long after it goes out the conversation should come back if nobody has
   *  answered, or null for none. */
  followUpMinutes: number | null
  /** Whether mail from the recipient took the timer off before it could go. */
  held: boolean
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
  onSchedule: (wallClock: string, followUpMinutes: number | null) => void
  onCancel: () => void
}

export function SendLater({
  sendAt, sendState, sendError, followUpMinutes, held, minWallClock, timezone, busy, disabled,
  onSchedule, onCancel,
}: Props) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(minWallClock)
  // Held here rather than read straight off the draft so that changing it and
  // pressing Never mind leaves the saved one alone.
  const [followUp, setFollowUp] = useState<number | null>(followUpMinutes)
  // A day and a time of somebody's own choosing, as the browser's own box spells
  // it. Three ready-made answers cover most of it and none of them covers "the
  // Monday they said they would decide by".
  const [chaseWhen, setChaseWhen] = useState('')
  const [problem, setProblem] = useState('')

  const scheduled = sendState === 'scheduled' || sendState === 'sending'

  // The moment the typed wall clock means, worked out the same way the server
  // works it out: against the SITE's zone rather than this browser's. It is what
  // the follow-up answers are counted from - "tomorrow morning" for a message
  // leaving on Friday night is Saturday morning.
  const wall = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value)
  const departure = wall ? instantAtWallClock(wall[1]!, wall[2]!, timezone) : null
  const choices = departure ? followUpOptions(departure, timezone) : []
  // What is chosen, as a moment, so a chip can show itself pressed and the line
  // underneath can say the day rather than a number of minutes.
  const chaseAt = departure && followUp !== null
    ? new Date(departure.getTime() + followUp * 60_000)
    : null

  /** A moment somebody picked, kept as the length of time that is stored. */
  const chooseChase = (until: Date) => {
    if (!departure) return
    const minutes = followUpMinutesBetween(departure, until)
    if (minutes < MIN_FOLLOW_UP_MINUTES) {
      setProblem('Pick a time after the message has gone, not before it.')
      return
    }
    setProblem('')
    setFollowUp(minutes)
  }

  const schedule = () => {
    if (!value) {
      setProblem('Pick the day and the time it should go out.')
      return
    }
    setProblem('')
    setOpen(false)
    onSchedule(value, followUp)
  }

  return (
    <div className="uin-sendlater">
      {sendState === 'failed' && (
        <div className="alert alert-danger" role="alert">
          This one did not go out.{sendError ? ` ${sendError}` : ''} It is still here, so you can
          fix it and send it or set another time.
        </div>
      )}

      {/* Nothing has been sent, and the writing is untouched. Said plainly,
          because the last thing the screen said about this message was that it
          was going out at a particular time. */}
      {held && !scheduled && (
        <div className="alert alert-info" role="status">
          They wrote to you {sendAt ? `before this went out ${describeSendAt(sendAt, new Date(), timezone)}` : 'before this went out'},
          so the timer came off it and nothing was sent. Read what they said, then send this,
          change it or throw it away.
        </div>
      )}

      {scheduled && (
        <div className="alert alert-info" role="status">
          {sendState === 'sending'
            ? 'This one is going out now.'
            : `This is set to go out ${describeSendAt(sendAt, new Date(), timezone)}. It leaves on its own - you do not have to be here.`}
          {sendState === 'scheduled' && followUpMinutes && sendAt ? (
            <> If nobody has replied by{' '}
              {describeSendAt(
                new Date(new Date(sendAt).getTime() + followUpMinutes * 60_000),
                new Date(),
                timezone,
              )}, the conversation comes back to whoever wrote it.</>
          ) : null}
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
          {/* Beside the time rather than behind another button: whether to chase
              it is part of the same thought as when to send it, and a chase
              nobody was offered is a chase nobody sets.

              The same three answers, in the same words, that putting a
              conversation to sleep offers - with the same day-and-time box
              underneath for the one they do not cover. Two controls that mean
              "bring this back later" and disagree about how to say it is one
              vocabulary too many. */}
          <div className="field">
            <span className="uin-recipients" id="uin-follow-up-label">
              Bring it back if nobody replies
            </span>
            <div className="uin-thread-actions" role="group" aria-labelledby="uin-follow-up-label">
              <button
                type="button"
                className="uin-chip"
                aria-pressed={followUp === null}
                onClick={() => { setFollowUp(null); setProblem('') }}
              >
                Leave it
              </button>
              {choices.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  className="uin-chip"
                  aria-pressed={chaseAt !== null && chaseAt.getTime() === choice.until.getTime()}
                  onClick={() => chooseChase(choice.until)}
                >
                  {choice.label}
                </button>
              ))}
            </div>
            <div className="uin-snooze-custom">
              <label htmlFor="uin-follow-up-when">Or pick a day and time</label>
              <input
                id="uin-follow-up-when"
                type="datetime-local"
                value={chaseWhen}
                // Never earlier than the message itself: a chase before the send
                // is a conversation coming back to ask about something that has
                // not happened.
                min={value || minWallClock}
                onChange={(e) => { setChaseWhen(e.target.value); setProblem('') }}
              />
              <button
                type="button"
                className="uin-chip"
                disabled={!chaseWhen}
                onClick={() => {
                  const picked = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(chaseWhen)
                  if (!picked) {
                    setProblem('That is not a date and time this understands.')
                    return
                  }
                  chooseChase(instantAtWallClock(picked[1]!, picked[2]!, timezone))
                }}
              >
                Bring it back then
              </button>
            </div>
            <span className="uin-field-hint">
              {chaseAt
                ? `It comes back to whoever wrote it ${describeSendAt(chaseAt, new Date(), timezone)}, unless they answer first - which brings it back straight away.`
                : 'The conversation goes quiet until whenever you say, and comes back to whoever wrote the message - unless they answer, which brings it back anyway. So you only ever see the chase if there was nothing to chase.'}
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
