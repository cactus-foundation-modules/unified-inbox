'use client'

import { describeSendAt } from '@/modules/unified-inbox/lib/scheduled'
import type { DraftSendState } from '@/modules/unified-inbox/lib/types'

// What a message with a time on it has to say for itself.
//
// Three states, three sentences, and none of them is optional: the last thing
// the screen said about a scheduled message was that it was going out at a
// particular time, so anything that changed - it went wrong, it was stood down,
// it is going now - has to be said out loud where the message is.
//
// Shared by both composers. The reply box picks its time from a menu behind the
// alarm clock and the new-message dialog still has the panel with the chase in
// it, but what they say afterwards is the same three sentences, and two copies
// of a sentence is one copy that gets fixed.

type Props = {
  /** When it is set to go, as an ISO stamp, or null while it is not set. */
  sendAt: string | null
  sendState: DraftSendState
  /** Why the last attempt was refused, when there was one. */
  sendError: string | null
  /** How long after it goes out the conversation comes back if nobody has
   *  answered, or null for none. */
  followUpMinutes: number | null
  /** Whether mail from the recipient took the timer off before it could go. */
  held: boolean
  /** The site's zone, which is the one every time on the screen is stamped in. */
  timezone: string
}

export function ScheduleNotice({
  sendAt, sendState, sendError, followUpMinutes, held, timezone,
}: Props) {
  const scheduled = sendState === 'scheduled' || sendState === 'sending'

  return (
    <>
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
    </>
  )
}
