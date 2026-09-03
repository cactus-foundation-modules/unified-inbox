'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { snoozeOptions } from '@/modules/unified-inbox/lib/list'

// Assign it, put it to sleep, mark it done, or push it back to unread so it is
// still there tomorrow. Everything here is one small request and a refresh -
// the list beside it is server-rendered, so the counts and the row's own tags
// come back correct without this component having to know how to redraw them.

type Props = {
  threadId: string
  status: string
  unread: boolean
  assigneeUserId: string | null
  staff: Array<{ id: string; name: string }>
  /** The site's timezone, so "tomorrow morning" is nine o'clock here rather
   *  than nine o'clock UTC. */
  timezone: string
}

/** Now, written the way a datetime-local box writes it: local time, minutes,
 *  no zone. `toISOString` would hand it UTC and the box would read that as
 *  local, which in a British summer is an hour in the past. */
function localNow(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`
}

export function ThreadActions({ threadId, status, unread, assigneeUserId, staff, timezone }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [snoozing, setSnoozing] = useState(false)
  // A time of somebody's own choosing, as the browser's own date-and-time box
  // spells it: "2026-09-04T14:30", local, no zone. Three ready-made answers
  // cover most of it and none of them covers "the morning they said they would
  // ring back".
  const [customWhen, setCustomWhen] = useState('')
  const [customError, setCustomError] = useState('')
  const [assigning, setAssigning] = useState(false)
  // Which button is waiting, not merely that something is: every one of them
  // greys out together, so a shared "in flight" would put the busy words on all
  // four at once and none of them would be the one that was pressed.
  const [pending, setPending] = useState<string | null>(null)
  const assignedTo = staff.find((person) => person.id === assigneeUserId)?.name ?? null

  const patch = useCallback(async (body: Record<string, unknown>, what: string | null = null) => {
    setBusy(true)
    setPending(what)
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
      setSnoozing(false)
      setAssigning(false)
      router.refresh()
    } catch {
      setError('The site could not be reached, so nothing changed.')
    } finally {
      setBusy(false)
      setPending(null)
    }
  }, [router, threadId])

  return (
    <div className="uin-actions">
      {/* Four buttons of the same build. Whose desk it is on was a bare native
          menu in among them, a different height with a different border and its
          own arrow, which read as something left half-finished rather than as
          one of the four. It opens the same kind of row the reminder does.
          None of them is filled in: the one filled button on this screen is
          Send, at the bottom of the writing box, and two competing filled
          buttons say neither is the thing to do. */}
      <div className="uin-thread-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy}
          onClick={() => setAssigning((v) => !v)}
          aria-expanded={assigning}
          aria-controls="uin-assign-panel"
        >
          {assignedTo ? `With ${assignedTo}` : 'With nobody yet'}
        </button>

        {status === 'done' ? (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                  onClick={() => patch({ status: 'open' }, 'open')}>
            {pending === 'open' ? 'Opening it...' : 'Open it again'}
          </button>
        ) : (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                  onClick={() => patch({ status: 'done' }, 'done')}>
            {pending === 'done' ? 'Marking it...' : 'Mark as done'}
          </button>
        )}

        <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                onClick={() => setSnoozing((v) => !v)} aria-expanded={snoozing}
                aria-controls="uin-snooze-panel">
          {status === 'snoozed' ? 'Change when it comes back' : 'Remind me later'}
        </button>

        <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                onClick={() => patch({ unread: !unread }, 'read')}>
          {pending === 'read'
            ? 'Changing it...'
            : unread ? 'Mark as read' : 'Mark as unread'}
        </button>
      </div>

      {assigning && (
        <div className="uin-thread-actions" id="uin-assign-panel">
          <span className="uin-recipients">Hand it to</span>
          <button
            type="button"
            className="uin-chip"
            disabled={busy}
            aria-pressed={!assigneeUserId}
            onClick={() => patch({ assigneeUserId: null })}
          >
            Nobody
          </button>
          {staff.map((person) => (
            <button
              key={person.id}
              type="button"
              className="uin-chip"
              disabled={busy}
              aria-pressed={person.id === assigneeUserId}
              onClick={() => patch({ assigneeUserId: person.id })}
            >
              {person.name}
            </button>
          ))}
        </div>
      )}

      {snoozing && (
        <div className="uin-thread-actions" id="uin-snooze-panel">
          {snoozeOptions(new Date(), timezone).map((option) => (
            <button
              key={option.id}
              type="button"
              className="uin-chip"
              disabled={busy}
              onClick={() => patch({ status: 'snoozed', snoozeUntil: option.until.toISOString() })}
            >
              {option.label}
            </button>
          ))}
          {status === 'snoozed' && (
            <button type="button" className="uin-chip" disabled={busy} onClick={() => patch({ status: 'open' })}>
              Bring it back now
            </button>
          )}

          <div className="uin-snooze-custom">
            <label htmlFor="uin-snooze-when">Or pick a day and time</label>
            <input
              id="uin-snooze-when"
              type="datetime-local"
              value={customWhen}
              // The browser's own box will not offer a moment that has already
              // been. Checked again below, because the attribute is a courtesy
              // rather than a guarantee.
              min={localNow()}
              disabled={busy}
              onChange={(e) => { setCustomWhen(e.target.value); setCustomError('') }}
            />
            <button
              type="button"
              className="uin-chip"
              disabled={busy || !customWhen}
              onClick={() => {
                const when = new Date(customWhen)
                if (Number.isNaN(when.getTime())) {
                  setCustomError('That is not a date this can read.')
                  return
                }
                if (when.getTime() <= Date.now()) {
                  setCustomError('Pick a time that has not happened yet.')
                  return
                }
                setCustomError('')
                void patch({ status: 'snoozed', snoozeUntil: when.toISOString() })
              }}
            >
              Remind me then
            </button>
            {customError && (
              <span role="alert" style={{ color: 'var(--color-destructive-hover)', fontSize: '0.8125rem' }}>
                {customError}
              </span>
            )}
          </div>
        </div>
      )}

      {error && <div className="alert alert-danger" role="alert">{error}</div>}
    </div>
  )
}
