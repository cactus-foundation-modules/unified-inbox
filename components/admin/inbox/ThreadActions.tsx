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
}

export function ThreadActions({ threadId, status, unread, assigneeUserId, staff }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [snoozing, setSnoozing] = useState(false)

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
      setSnoozing(false)
      router.refresh()
    } catch {
      setError('The site could not be reached, so nothing changed.')
    } finally {
      setBusy(false)
    }
  }, [router, threadId])

  return (
    <div style={{ display: 'grid', gap: '0.5rem' }}>
      <div className="uin-thread-actions">
        <label className="sr-only" htmlFor="uin-assign">Assign to</label>
        <select
          id="uin-assign"
          value={assigneeUserId ?? ''}
          disabled={busy}
          onChange={(e) => patch({ assigneeUserId: e.target.value || null })}
        >
          <option value="">Nobody yet</option>
          {staff.map((person) => (
            <option key={person.id} value={person.id}>{person.name}</option>
          ))}
        </select>

        {status === 'done' ? (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                  onClick={() => patch({ status: 'open' })}>
            Open it again
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-sm" disabled={busy}
                  onClick={() => patch({ status: 'done' })}>
            Mark as done
          </button>
        )}

        <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                onClick={() => setSnoozing((v) => !v)} aria-expanded={snoozing}>
          {status === 'snoozed' ? 'Change when it comes back' : 'Remind me later'}
        </button>

        <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                onClick={() => patch({ unread: !unread })}>
          {unread ? 'Mark as read' : 'Mark as unread'}
        </button>
      </div>

      {snoozing && (
        <div className="uin-thread-actions">
          {snoozeOptions(new Date()).map((option) => (
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
        </div>
      )}

      {error && <div className="alert alert-danger">{error}</div>}
    </div>
  )
}
