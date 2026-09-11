'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { inboxHref } from '@/modules/unified-inbox/lib/list'
import { ConfirmDialog } from './ConfirmDialog'
import { Dropdown, MenuItem } from './Dropdown'
import { useComposerOpen } from './ComposerOpen'
import { MoreIcon, ReplyIcon } from './icons'

// Answering a message, from the message - and the two things that can be done
// to one message rather than to the whole conversation.
//
// This used to be a row of three buttons above the whole conversation, which
// answers the conversation rather than anything in it - and on a thread of nine
// messages that is a button with no opinion about which one you meant. So the
// arrow sits on the message, where every mail program has put it, and the
// rarer three live behind the dots beside it: replying is what somebody came
// here to do, and burying it a level down to make room for Forward taxes the
// common case to pay for the rare one.
//
// The message it sits on is the message it answers. Both the arrow and the two
// entries above it carry that id to the writing box, which sends it with the
// reply so the words quoted underneath are the ones being answered rather than
// whatever happens to be at the bottom of the conversation.
//
// THE LAST TWO ENTRIES are the ones that change the conversation itself, and
// they are the answer to the same problem from opposite ends. Threading is a
// heuristic: a dropped References header and two customers who both wrote
// "Re: Quote" is all it takes to glue a stray email onto somebody else's
// conversation. Until these existed the only answers were to live with it, or
// to throw the whole conversation away. Both are ruled off from the everyday
// ones above them, both ask before they do anything, and neither is drawn at
// all for a reader who may not manage the addresses - the server settles that.
//
// Its own island, and a small one, because ThreadPane is a server component
// that renders four hundred lines of somebody's conversation and should stay
// one. See MessageActions for the same argument made at more length.

/** What went wrong, in words worth reading. Both routes already answer in plain
 *  English for everything they can explain - the only message in a conversation,
 *  one a channel owns, a conversation that has since been merged away - so
 *  those are shown as they came. Only the ones with nothing useful to say are
 *  rewritten here. */
function refusal(status: number, message: string | null): string {
  if (status === 401) return 'You have been signed out. Sign in again and it will still be here.'
  if (status === 403) return 'You are not allowed to change this conversation.'
  if (status === 404 && !message) return 'That message is not here any more.'
  return message ?? 'That could not be done just now. Try again in a moment.'
}

type Props = {
  threadId: string
  /** The message these controls sit on, which is the one an answer quotes.
   *  Null on an internal note: a note is written for colleagues on this screen
   *  and is never quoted into anything that leaves, so answering from one falls
   *  back to the newest message that actually went somewhere. */
  messageId: string | null
  /** The message these controls sit on, always - including on a note, which
   *  can be thrown away and moved out like anything else. Kept apart from
   *  `messageId` above on purpose: that one is "what an answer quotes" and is
   *  deliberately empty on a note. */
  actOn: string
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
  /** Whether this message can be thrown away out of this conversation. Takes
   *  the grant to manage the addresses, and is deliberately NOT offered on a
   *  message that already carries the far-end Delete button in its foot: that
   *  one asks the channel to delete it at the phone company as well, which is
   *  a larger act, and two buttons a few pixels apart that both say Delete and
   *  mean different things is how somebody deletes the wrong thing. */
  canDeleteHere: boolean
  /** Whether it can be moved out onto a conversation of its own. */
  canSplit: boolean
  /** Where the screen is, so the browser can be sent to the new conversation
   *  once a message has been moved onto it. The pane is rendered from the query
   *  string, so this is the whole of what "which conversation is open" means. */
  base: string
  params: Record<string, string>
}

export function MessageMenu({
  threadId, messageId, actOn, canReply, canReplyAll, canForward,
  canDeleteHere, canSplit, base, params,
}: Props) {
  const router = useRouter()
  const { toggle } = useComposerOpen()
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState<'delete' | 'split' | null>(null)
  const [error, setError] = useState('')

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

  const remove = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/m/unified-inbox/messages/${actOn}/remove`, {
        method: 'POST',
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        setError(refusal(response.status, body?.error ?? null))
        return
      }
      setAsking(null)
      // The count under the subject is written on the conversation rather than
      // worked out when it is read, and the list beside this is rendered on the
      // server, so a refresh is what makes the page agree with itself.
      router.refresh()
    } catch {
      setError('The site could not be reached, so nothing was deleted.')
    } finally {
      setBusy(false)
    }
  }, [actOn, router])

  const split = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/m/unified-inbox/messages/${actOn}/split`, {
        method: 'POST',
      })
      const body = (await response.json().catch(() => null)) as
        { error?: string; threadId?: string } | null
      if (!response.ok || !body?.threadId) {
        setError(refusal(response.status, body?.error ?? null))
        return
      }
      setAsking(null)
      // Straight to it, rather than refreshing and leaving somebody looking at
      // a conversation a message has just vanished from. `page` goes with it:
      // the new conversation is at the top of the list, and staying on page
      // four of it would be a list with nothing to do with what is open.
      router.push(inboxHref(base, params, { id: body.threadId, page: null }))
      router.refresh()
    } catch {
      setError('The site could not be reached, so nothing was moved.')
    } finally {
      setBusy(false)
    }
  }, [actOn, base, params, router])

  return (
    <span className="uin-msg-tools">
      <Dropdown
        className="uin-icon-btn"
        label={MoreIcon}
        ariaLabel="More things to do with this message"
        title="More"
        align="end"
        width={230}
        disabled={busy}
      >
        {canReplyAll && <MenuItem onClick={() => toggle('reply-all', messageId)}>Reply all</MenuItem>}
        {canForward && <MenuItem onClick={() => toggle('forward', messageId)}>Forward</MenuItem>}
        {/* Only where there is no arrow beside these dots. On a conversation
            that CAN be answered, the full note box is one press of the arrow
            and one chip away, and a fourth entry here would be a second door
            to the same room. On one that cannot - a discussion - the arrow is
            not drawn at all, and without this the only way to leave a note is
            the one-line bar at the foot, which carries no attachment and can
            mention nobody. */}
        {!canReply && <MenuItem onClick={() => toggle('note')}>Internal note</MenuItem>}
        <MenuItem onClick={() => void markUnread()}>Mark as unread</MenuItem>
        {(canSplit || canDeleteHere) && <div className="uin-menu-sep" role="separator" />}
        {canSplit && (
          <MenuItem onClick={() => { setError(''); setAsking('split') }}>
            Move to its own conversation
          </MenuItem>
        )}
        {canDeleteHere && (
          <MenuItem onClick={() => { setError(''); setAsking('delete') }}>
            Delete this message
          </MenuItem>
        )}
      </Dropdown>

      {canReply && (
        <button
          type="button"
          className="uin-icon-btn"
          title="Reply"
          aria-label="Reply to this message"
          onClick={() => toggle('reply', messageId)}
        >
          {ReplyIcon}
        </button>
      )}

      {/* Beside the dots, in the header row they sit in. Same colour as the
          other refusals on this screen: --color-danger measures under AA on
          this ground at this size. */}
      {error && (
        <span style={{ color: 'var(--color-destructive-hover)' }} role="alert">{error}</span>
      )}

      <ConfirmDialog
        open={asking === 'split'}
        title="Move this message to its own conversation?"
        body={
          <>
            <p>
              It leaves this conversation and starts one of its own, with everything
              attached to it. The rest of this conversation stays exactly as it is, and
              nothing is sent to anybody.
            </p>
            <p>
              If that turns out to be wrong, merge the two back together.
            </p>
          </>
        }
        confirmLabel="Move it out"
        busy={busy}
        onCancel={() => { if (!busy) { setAsking(null); setError('') } }}
        onConfirm={() => void split()}
      />

      <ConfirmDialog
        open={asking === 'delete'}
        title="Delete this message?"
        body={
          <>
            <p>
              It goes from this site for everybody who can see this address, along with
              anything attached to it, and there is no getting it back. The rest of the
              conversation stays.
            </p>
            <p>
              Nothing is deleted from the mailbox or the service it came from - this is a
              fact about what this site holds. It will not be collected again.
            </p>
          </>
        }
        confirmLabel="Delete it"
        destructive
        busy={busy}
        onCancel={() => { if (!busy) { setAsking(null); setError('') } }}
        onConfirm={() => void remove()}
      />
    </span>
  )
}
