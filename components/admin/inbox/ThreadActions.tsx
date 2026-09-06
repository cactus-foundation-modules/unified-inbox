'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dropdown, MenuItem } from './Dropdown'
import { SnoozePanel } from './SnoozePanel'
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
  staff: Array<{ id: string; name: string }>
  /** The site's timezone, so "tomorrow morning" is nine o'clock here rather
   *  than nine o'clock UTC. */
  timezone: string
}

/** What to call where it stands, on the button that says so. Not a sentence:
 *  this is the state of the thing, and it is read at a glance beside the
 *  arrow that changes it. */
const STATUS_WORDS: Record<string, string> = {
  open: 'Open',
  done: 'Done',
  snoozed: 'Snoozed',
}

export function ThreadActions({ threadId, status, assigneeUserId, staff, timezone }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const assignedTo = staff.find((person) => person.id === assigneeUserId)?.name ?? null

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
        return
      }
      router.refresh()
    } catch {
      setError('The site could not be reached, so nothing changed.')
    } finally {
      setBusy(false)
    }
  }, [router, threadId])

  return (
    <div className="uin-actions">
      <div className="uin-thread-actions">
        {/* Whose it is, on the left. It said "With nobody yet", which describes
            the state rather than offering the thing you press it to do - and
            the state is already written on the row in the list. */}
        <Dropdown
          label={assignedTo ? `With ${assignedTo}` : 'Assign'}
          disabled={busy}
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

        {/* The clock and where it stands, hard against the far edge - the two
            things you press on the way OUT of a conversation, together, at the
            end of the row rather than scattered through it. */}
        <div className="uin-thread-actions-end">
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

          <Dropdown
            label={<>{STATUS_WORDS[status] ?? 'Open'}{ChevronDownIcon}</>}
            className="btn btn-secondary btn-sm uin-status-btn"
            title="Where this conversation stands"
            align="end"
            width={200}
            disabled={busy}
          >
            {status !== 'open' && (
              <MenuItem disabled={busy} onClick={() => void patch({ status: 'open' })}>Open</MenuItem>
            )}
            {status !== 'done' && (
              <MenuItem disabled={busy} onClick={() => void patch({ status: 'done' })}>Done</MenuItem>
            )}
          </Dropdown>
        </div>
      </div>

      {error && <div className="alert alert-danger" role="alert">{error}</div>}
    </div>
  )
}
