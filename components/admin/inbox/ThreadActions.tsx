'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dropdown, MenuItem } from './Dropdown'
import { SnoozePanel } from './SnoozePanel'
import { SpamButton } from './SpamButton'
import { UndoToast } from './UndoToast'
import { AlarmIcon, ChevronDownIcon } from './icons'

// What is done TO a conversation: whose desk it is on, where it stands, and
// when it comes back. Everything here is one small request and a refresh - the
// list beside it is server-rendered, so the counts and the row's own tags come
// back correct without this component having to know how to redraw them.
//
// It was four buttons in a row that spelled out what pressing them would do -
// "Mark as done", "Remind me later". Which is a row of instructions rather than
// a row of controls, and it never said where the conversation actually stood
// without reading the tag on the line above. So the middle of it is now a
// button that SAYS where it stands and opens the other answers, the reminder is
// the clock beside it, and marking something read again went where it belongs:
// on a message, behind its own dots.

type Props = {
  threadId: string
  status: string
  assigneeUserId: string | null
  /** When a snoozed conversation is due back, as an ISO string. Only used to
   *  put it back the way it was if marking it done is undone - the API will
   *  not take a snooze with no date on it. */
  snoozeUntil: string | null
  staff: Array<{ id: string; name: string }>
  /** The site's timezone, so "tomorrow morning" is nine o'clock here rather
   *  than nine o'clock UTC. */
  timezone: string
  /** Whether THIS reader has put it in their spam folder. One person's own
   *  opinion, which is why it rides here rather than in `status` beside Done
   *  and Snoozed: those two are the conversation's, shared by everybody who can
   *  read it, and junk is not. */
  spam: boolean
  /** The colleague whose spam folder it would land in, when that is not the
   *  reader's own - see spamOwnerFor. Null the rest of the time. */
  spamOwnerName: string | null
  /** Who wrote it, for the question the junk button asks afterwards. Null where
   *  there is nobody to block. */
  senderAddress: string | null
  /** Whether that sender is already refused across the whole site. */
  senderBlocked: boolean
  /** Whether this reader may do the refusing. */
  canBlock: boolean
}

/** What to call where it stands, on the button that says so. Not a sentence:
 *  this is the state of the thing, and it is read at a glance beside the
 *  arrow that changes it. */
const STATUS_WORDS: Record<string, string> = {
  open: 'Open',
  done: 'Done',
  snoozed: 'Snoozed',
}

export function ThreadActions({
  threadId, status, assigneeUserId, snoozeUntil, staff, timezone,
  spam, spamOwnerName, senderAddress, senderBlocked, canBlock,
}: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** What putting it back would mean, while the offer to do so is still on the
   *  screen. Null the rest of the time, which is also what says there is no
   *  toast. Held as the whole change rather than a status, because a snooze
   *  without the date it is due back is a change the API refuses. */
  const [undoTo, setUndoTo] = useState<Record<string, unknown> | null>(null)
  const assignedTo = staff.find((person) => person.id === assigneeUserId)?.name ?? null

  /** Says whether it saved, because marking done only offers to undo itself
   *  once the site has agreed that it happened. */
  const patch = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/m/unified-inbox/threads/${threadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        setError((await response.json().catch(() => null))?.error ?? 'That did not save.')
        return false
      }
      router.refresh()
      return true
    } catch {
      setError('The site could not be reached, so nothing changed.')
      return false
    } finally {
      setBusy(false)
    }
  }, [router, threadId])

  /** Done is the one change that hides the conversation from the view it was
   *  found in, so it is the one that offers to take itself back - to where it
   *  actually stood, which for something asleep until Monday is asleep until
   *  Monday rather than open on the list this morning. */
  const markDone = useCallback(async () => {
    const back = status === 'snoozed' && snoozeUntil
      ? { status: 'snoozed', snoozeUntil }
      : { status: 'open' }
    if (await patch({ status: 'done' })) setUndoTo(back)
  }, [patch, snoozeUntil, status])

  return (
    <>
      <div className="uin-thread-actions">
        {/* The basket, the clock, then whose it is, then where it stands. All
            four sit on the subject line now, hard against the way out of the
            conversation: they are what you press on the way OUT of one, and a
            row of them on a line of their own was a band of chrome between the
            subject and the message.
            Junk goes first, on the left, because it is the one press that ends
            the conversation rather than arranging it - the same place every
            mail program puts it, and the furthest of the four from the reply
            arrow. */}
        <SpamButton
          threadId={threadId}
          spam={spam}
          ownerName={spamOwnerName}
          senderAddress={senderAddress}
          senderBlocked={senderBlocked}
          canBlock={canBlock}
          disabled={busy}
        />
        <Dropdown
          className="uin-icon-btn uin-icon-btn-framed"
          label={AlarmIcon}
          ariaLabel="Set when this comes back"
          title="Snooze"
          align="end"
          width={280}
          disabled={busy}
          panelClassName="uin-menu-snooze"
        >
          <SnoozePanel
            status={status}
            timezone={timezone}
            busy={busy}
            onSnooze={(until) => void patch({ status: 'snoozed', snoozeUntil: until.toISOString() })}
            onWake={() => void patch({ status: 'open' })}
          />
        </Dropdown>

        {/* Whose it is. It said "With nobody yet", which describes the state
            rather than offering the thing you press it to do - and the state is
            already written on the row in the list. */}
        <Dropdown
          label={<>{assignedTo ? `With ${assignedTo}` : 'Assign'}{ChevronDownIcon}</>}
          className="btn btn-secondary btn-sm uin-status-btn"
          disabled={busy}
          align="end"
          width={220}
        >
          <div className="uin-menu-title">Hand it to</div>
          <MenuItem
            disabled={busy}
            hint={assigneeUserId ? undefined : 'Now'}
            onClick={() => void patch({ assigneeUserId: null })}
          >
            Nobody
          </MenuItem>
          {staff.map((person) => (
            <MenuItem
              key={person.id}
              disabled={busy}
              hint={person.id === assigneeUserId ? 'Now' : undefined}
              onClick={() => void patch({ assigneeUserId: person.id })}
            >
              {person.name}
            </MenuItem>
          ))}
        </Dropdown>

        {/* No width on this one: two one-word answers do not want two hundred
            pixels of panel, and the panel now takes only what is in it. */}
        <Dropdown
          label={<>{STATUS_WORDS[status] ?? 'Open'}{ChevronDownIcon}</>}
          className="btn btn-secondary btn-sm uin-status-btn"
          title="Where this conversation stands"
          align="end"
          disabled={busy}
        >
          {status !== 'open' && (
            <MenuItem
              disabled={busy}
              onClick={() => {
                setUndoTo(null)
                void patch({ status: 'open' })
              }}
            >
              Open
            </MenuItem>
          )}
          {status !== 'done' && (
            <MenuItem disabled={busy} onClick={() => void markDone()}>Done</MenuItem>
          )}
        </Dropdown>
      </div>

      {/* The five seconds in which marking something done is still a mistake
          you can take back. It puts it back where it was rather than simply
          opening it: something snoozed until Monday that was closed by
          accident wants to be snoozed until Monday again. */}
      {undoTo && (
        <UndoToast onUndo={() => void patch(undoTo)} onDone={() => setUndoTo(null)}>
          Marked as done.
        </UndoToast>
      )}

      {/* Its own line under the subject rather than squeezed onto the end of
          it: the row above is three controls on one line by design and a whole
          sentence in it would push them off the screen. */}
      {error && <div className="alert alert-danger uin-thread-actions-error" role="alert">{error}</div>}
    </>
  )
}
