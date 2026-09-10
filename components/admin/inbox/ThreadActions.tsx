'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AdminTooltip } from '@/components/admin/Tooltip'
import { Dropdown, MenuItem } from './Dropdown'
import { SnoozePanel } from './SnoozePanel'
import { SpamButton } from './SpamButton'
import { useOfferUndo } from './UndoProvider'
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
  /** The list with nothing open on it - where the close cross points. Junking
   *  something goes there, since the conversation has just left every list this
   *  reader could have been standing in. */
  closeHref: string
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
  spam, spamOwnerName, senderAddress, senderBlocked, canBlock, closeHref,
}: Props) {
  const router = useRouter()
  const offerUndo = useOfferUndo()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const assignedTo = staff.find((person) => person.id === assigneeUserId)?.name ?? null

  /** Where this conversation stood before the press, as the change that would
   *  put it back. The whole change rather than a status, because a snooze
   *  without the date it is due back is a change the API refuses.
   *
   *  Read at the moment the button is pressed rather than when the offer is
   *  taken: by then this component is very probably unmounted, because closing
   *  a conversation shuts the pane it was drawn in. */
  const wasAt = useCallback((): Record<string, unknown> => (
    status === 'snoozed' && snoozeUntil
      ? { status: 'snoozed', snoozeUntil }
      : { status: status === 'done' ? 'done' : 'open' }
  ), [snoozeUntil, status])

  /** Put it back, from a screen that no longer exists. A bare request, for the
   *  reason given at the top of UndoProvider - the redraw is that component's
   *  job, not this one's. */
  const restore = useCallback(async (to: Record<string, unknown>) => {
    await fetch(`/api/m/unified-inbox/threads/${threadId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(to),
    })
  }, [threadId])

  /** Says whether it saved, because marking done only offers to undo itself
   *  once the site has agreed that it happened. */
  const patch = useCallback(async (
    body: Record<string, unknown>,
    { refresh = true }: { refresh?: boolean } = {},
  ) => {
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
      // Held back where the caller is about to leave anyway: a redraw of the
      // screen being walked away from is a second server render for a pane
      // nobody will see, and it flashes on the way out.
      if (refresh) router.refresh()
      return true
    } catch {
      setError('The site could not be reached, so nothing changed.')
      return false
    } finally {
      setBusy(false)
    }
  }, [router, threadId])

  /** Marking it done, and putting it to sleep, both take the conversation off
   *  the list it was found on - so both do the same two things afterwards.
   *
   *  The pane goes back to "Nothing open". Somebody who has just filed a
   *  conversation is done with it, and leaving it sitting there under their eyes
   *  while the list beside it has dropped the row is a screen that disagrees
   *  with itself - which is exactly what junking one has always done (see
   *  SpamButton and its closeHref).
   *
   *  And the offer to take it back goes up, to where it actually stood: something
   *  asleep until Monday that was filed by accident wants to be asleep until
   *  Monday again, not open on this morning's list. */
  const closeWith = useCallback(async (change: Record<string, unknown>, said: string) => {
    const back = wasAt()
    if (!(await patch(change, { refresh: false }))) return
    offerUndo({ message: said, undo: () => restore(back) })
    router.push(closeHref)
  }, [closeHref, offerUndo, patch, restore, router, wasAt])

  return (
    <>
      <div className="uin-thread-actions">
        {/* The junk sign, the clock, then whose it is, then where it stands. All
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
          closeHref={closeHref}
          disabled={busy}
        />
        {/* The other wordless one, and given the same tooltip as the junk sign
            for the same reason: a clock on its own is a guess until something
            says which of the four things a clock could mean this one is. */}
        <AdminTooltip body="Snooze - set when this comes back">
          <Dropdown
            className="uin-icon-btn uin-icon-btn-framed"
            label={AlarmIcon}
            ariaLabel="Set when this comes back"
            align="end"
            width={280}
            disabled={busy}
            panelClassName="uin-menu-snooze"
          >
            <SnoozePanel
              status={status}
              timezone={timezone}
              busy={busy}
              onSnooze={(until) => void closeWith(
                { status: 'snoozed', snoozeUntil: until.toISOString() },
                'Snoozed.',
              )}
              onWake={() => void patch({ status: 'open' })}
            />
          </Dropdown>
        </AdminTooltip>

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
            <MenuItem disabled={busy} onClick={() => void patch({ status: 'open' })}>
              Open
            </MenuItem>
          )}
          {status !== 'done' && (
            <MenuItem disabled={busy} onClick={() => void closeWith({ status: 'done' }, 'Marked as done.')}>Done</MenuItem>
          )}
        </Dropdown>
      </div>

      {/* Its own line under the subject rather than squeezed onto the end of
          it: the row above is three controls on one line by design and a whole
          sentence in it would push them off the screen. */}
      {error && <div className="alert alert-danger uin-thread-actions-error" role="alert">{error}</div>}
    </>
  )
}
