'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AdminTooltip } from '@/components/admin/Tooltip'
import { BinButton } from './BinButton'
import { Dropdown, MenuItem } from './Dropdown'
import {
  refusalMessage, runOnMany, them, useBulkTargets, useSelection,
} from './Selection'
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
//
// Everything in this row that ENDS a conversation - the bin, the junk sign, the
// clock, and Done - acts on whatever is ticked in the list beside it as well as
// on the conversation being read. Picking six, opening one of them to check it
// is the right pile and pressing Done used to file exactly one, with the other
// five still ticked behind and nothing on the screen admitting it. See
// Selection. Handing it to somebody is deliberately NOT one of them: whose desk
// a conversation lands on is a decision per conversation, and the bar over the
// list has never offered it either.

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
  /** The other kind of door, where the channel itself can refuse the party on
   *  this conversation - the phone dropping a caller before it rings. Handed
   *  straight to the junk button, which is where refusing anybody is asked
   *  about now. Null where the channel cannot refuse anybody. */
  channelBlock: { label: string; blocked: boolean } | null
  /** Whether the conversation is in the relevant bin - the OWNER's, which on a
   *  colleague's own address is not the reader's. Rides here beside `spam` and
   *  for the same reason: it is one person's decision about a conversation
   *  rather than the conversation's own state. */
  binned: boolean
  /** The colleague whose bin it would land in, when that is not the reader's
   *  own - see binOwnerFor. Null the rest of the time. */
  binOwnerName: string | null
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
  spam, spamOwnerName, senderAddress, senderBlocked, canBlock, channelBlock, closeHref,
  binned, binOwnerName,
}: Props) {
  const router = useRouter()
  const offerUndo = useOfferUndo()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const assignedTo = staff.find((person) => person.id === assigneeUserId)?.name ?? null
  // This conversation, and everything else ticked in the list beside it.
  const targets = useBulkTargets(threadId)
  const many = targets.length > 1
  const { pickedRows, clear: dropSelection } = useSelection()

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

  /** Where EVERY conversation about to change stood, as the changes that would
   *  put each of them back there.
   *
   *  One change per conversation rather than one for the pile: a pile picked off
   *  an All list is rarely all in the same state, and a snooze needs the date it
   *  was due back or the API refuses it. The other conversations' states come
   *  from the list beside this one, which is the only thing that knows them -
   *  and this conversation's own comes from its props, because it may not be
   *  ticked in the list at all. */
  const whereTheyStood = useCallback((): Array<{ id: string; to: Record<string, unknown> }> => {
    const stood = new Map<string, Record<string, unknown>>(pickedRows.map((row) => [row.id, (
      row.status === 'snoozed' && row.snoozeUntil
        ? { status: 'snoozed', snoozeUntil: row.snoozeUntil }
        : { status: row.status === 'done' ? 'done' : 'open' }
    )]))
    stood.set(threadId, wasAt())
    return targets.map((id) => ({ id, to: stood.get(id) ?? { status: 'open' } }))
  }, [pickedRows, targets, threadId, wasAt])

  /** Put it back, from a screen that no longer exists. A bare request, for the
   *  reason given at the top of UndoProvider - the redraw is that component's
   *  job, not this one's. */
  const restore = useCallback(async (back: Array<{ id: string; to: Record<string, unknown> }>) => {
    await Promise.allSettled(back.map(({ id, to }) => fetch(`/api/m/unified-inbox/threads/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(to),
    })))
  }, [])

  /** Says whether it saved, because marking done only offers to undo itself
   *  once the site has agreed that it happened. */
  const patch = useCallback(async (
    body: Record<string, unknown>,
    { refresh = true, all = true }: { refresh?: boolean; all?: boolean } = {},
  ) => {
    setBusy(true)
    setError('')
    try {
      // `all: false` is how the one control here that is per-conversation - who
      // it is with - stays that way.
      const ids = all ? targets : [threadId]
      const { failed, count } = await runOnMany(ids, (id) =>
        fetch(`/api/m/unified-inbox/threads/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }))
      const refused = refusalMessage(failed, count)
      if (refused) {
        setError(refused)
        if (failed === count) return false
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
  }, [router, targets, threadId])

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
    const back = whereTheyStood()
    if (!(await patch(change, { refresh: false }))) return
    dropSelection()
    offerUndo({ message: said, undo: () => restore(back) })
    router.push(closeHref)
  }, [closeHref, dropSelection, offerUndo, patch, restore, router, whereTheyStood])

  /** What the toast says, which depends on how many went with the press.
   *  "Marked as done." over six conversations is a sentence that leaves five of
   *  them unaccounted for. */
  const said = useCallback((one: string, verb: string) => (
    many ? `${targets.length} ${them(targets.length)} ${verb}.` : one
  ), [many, targets.length])

  return (
    <>
      <div className="uin-thread-actions">
        {/* The bin, the junk sign, the clock, then whose it is, then where it
            stands. All five sit on the subject line now, hard against the way
            out of the conversation: they are what you press on the way OUT of
            one, and a row of them on a line of their own was a band of chrome
            between the subject and the message.
            The two that END a conversation rather than arranging it go first,
            on the left - the same place every mail program puts them, and the
            furthest of the row from the reply arrow. The bin is left of the
            junk sign because it is the commoner of the two by a distance:
            "I have finished with this" happens all day, and "this sender is a
            nuisance" happens on Tuesdays. Keeping them apart is the whole
            point of having both - people were reaching for the junk button to
            mean "delete", which slowly filled the spam folder with post that
            was not spam and made it useless for the one job it does have. */}
        <BinButton
          threadId={threadId}
          binned={binned}
          ownerName={binOwnerName}
          closeHref={closeHref}
          disabled={busy}
        />
        <SpamButton
          threadId={threadId}
          spam={spam}
          ownerName={spamOwnerName}
          senderAddress={senderAddress}
          senderBlocked={senderBlocked}
          canBlock={canBlock}
          channelBlock={channelBlock}
          closeHref={closeHref}
          disabled={busy}
        />
        {/* The other wordless one, and given the same tooltip as the junk sign
            for the same reason: a clock on its own is a guess until something
            says which of the four things a clock could mean this one is. */}
        <AdminTooltip body={many
          ? `Snooze - set when all ${targets.length} come back`
          : 'Snooze - set when this comes back'}>
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
              title={many ? `Snooze these ${targets.length}` : undefined}
              onSnooze={(until) => void closeWith(
                { status: 'snoozed', snoozeUntil: until.toISOString() },
                said('Snoozed.', 'snoozed'),
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
            onClick={() => void patch({ assigneeUserId: null }, { all: false })}
          >
            Nobody
          </MenuItem>
          {staff.map((person) => (
            <MenuItem
              key={person.id}
              disabled={busy}
              hint={person.id === assigneeUserId ? 'Now' : undefined}
              onClick={() => void patch({ assigneeUserId: person.id }, { all: false })}
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
              {many ? `Open - all ${targets.length}` : 'Open'}
            </MenuItem>
          )}
          {status !== 'done' && (
            <MenuItem
              disabled={busy}
              onClick={() => void closeWith({ status: 'done' }, said('Marked as done.', 'marked as done'))}
            >
              {many ? `Done - all ${targets.length}` : 'Done'}
            </MenuItem>
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
