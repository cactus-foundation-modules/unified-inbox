'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dropdown, MenuItem } from './Dropdown'
import { useComposerOpen } from './ComposerOpen'
import { MoreIcon, ReplyIcon } from './icons'

// Answering a message, from the message.
//
// This used to be a row of three buttons above the whole conversation, which
// answers the conversation rather than anything in it - and on a thread of nine
// messages that is a button with no opinion about which one you meant. So the
// arrow sits on the message, where every mail program has put it, and the
// rarer three live behind the dots beside it: replying is what somebody came
// here to do, and burying it a level down to make room for Forward taxes the
// common case to pay for the rare one.
//
// Its own island, and a small one, because ThreadPane is a server component
// that renders four hundred lines of somebody's conversation and should stay
// one. See MessageActions for the same argument made at more length.

type Props = {
  threadId: string
  /** Whether this reader may answer this conversation at all. No arrow and no
   *  Forward when they may not - decided on the server, per inbox. */
  canReply: boolean
  /** Whether there is anybody on this conversation besides the one person a
   *  plain reply would go to. Reply to all is not offered otherwise: it would
   *  do exactly what Reply does. */
  canReplyAll: boolean
  /** Whether it can be sent on to somebody else. Not the same question as
   *  Reply: a conversation another module owns is answered back down the
   *  channel it came from and cannot be forwarded anywhere, and the send route
   *  refuses one - so the entry that would ask for it is not drawn. */
  canForward: boolean
}

export function MessageMenu({ threadId, canReply, canReplyAll, canForward }: Props) {
  const router = useRouter()
  const { toggle } = useComposerOpen()
  const [busy, setBusy] = useState(false)

  /** Back to unread, so it is still waiting tomorrow. A conversation-wide
   *  thing said from a message, which is how mail programs say it: there is no
   *  such thing as one unread message in a thread you have open. */
  const markUnread = useCallback(async () => {
    setBusy(true)
    try {
      await fetch(`/api/m/unified-inbox/threads/${threadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unread: true }),
      })
      router.refresh()
    } catch {
      // Nothing changed, and the row in the list beside this still says so.
      // A message about it would be drawn inside a menu that has just shut.
    } finally {
      setBusy(false)
    }
  }, [router, threadId])

  return (
    <span className="uin-msg-tools">
      <Dropdown
        className="uin-icon-btn"
        label={MoreIcon}
        ariaLabel="More things to do with this message"
        title="More"
        align="end"
        width={200}
        disabled={busy}
      >
        {canReplyAll && <MenuItem onClick={() => toggle('reply-all')}>Reply all</MenuItem>}
        {canForward && <MenuItem onClick={() => toggle('forward')}>Forward</MenuItem>}
        {/* Only where there is no arrow beside these dots. On a conversation
            that CAN be answered, the full note box is one press of the arrow
            and one chip away, and a fourth entry here would be a second door
            to the same room. On one that cannot - a discussion - the arrow is
            not drawn at all, and without this the only way to leave a note is
            the one-line bar at the foot, which carries no attachment and can
            mention nobody. */}
        {!canReply && <MenuItem onClick={() => toggle('note')}>Internal note</MenuItem>}
        <MenuItem onClick={() => void markUnread()}>Mark as unread</MenuItem>
      </Dropdown>

      {canReply && (
        <button
          type="button"
          className="uin-icon-btn"
          title="Reply"
          aria-label="Reply to this message"
          onClick={() => toggle('reply')}
        >
          {ReplyIcon}
        </button>
      )}
    </span>
  )
}
