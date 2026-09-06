'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dropdown, MenuItem } from './Dropdown'
import { SnoozePanel } from './SnoozePanel'
import { AlarmIcon, ChevronDownIcon } from './icons'

// Working through something a colleague asked you to look at: put it off,
// finish it, pick it up again.
//
// The same three words the conversation itself uses, and deliberately the same
// controls, because it is the same gesture at a smaller scale. What differs is
// whose it is. A conversation has ONE status shared by everybody who can read
// it; an ask has one per person, so three colleagues asked about the same order
// each work through their own and none of them clears it from under the others.
// That is the whole reason this is not simply the button above it.
//
// One small request and a refresh, like everything else on this screen: the
// list beside it is server-rendered, so the counts and the row's own tag come
// back right without this component knowing how to redraw them.

type Props = {
  mentionId: string
  status: string
  /** The site's timezone, so "tomorrow morning" is nine o'clock here rather
   *  than nine o'clock UTC. */
  timezone: string
}

const STATUS_WORDS: Record<string, string> = {
  open: 'To do',
  done: 'Done',
  snoozed: 'Later',
}

export function MentionActions({ mentionId, status, timezone }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const patch = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/m/unified-inbox/mentions/${mentionId}`, {
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
  }, [mentionId, router])

  return (
    <div className="uin-ask-actions">
      <Dropdown
        className="uin-icon-btn uin-icon-btn-framed"
        label={AlarmIcon}
        ariaLabel="Set when this comes back to you"
        title="Come back to it later"
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
        label={<>{STATUS_WORDS[status] ?? 'To do'}{ChevronDownIcon}</>}
        className="btn btn-secondary btn-sm uin-status-btn"
        title="Where this stands with you"
        align="end"
        width={200}
        disabled={busy}
      >
        {status !== 'open' && (
          <MenuItem disabled={busy} onClick={() => void patch({ status: 'open' })}>
            {/* Named for what pressing it does rather than for the state it
                lands in: from Done, this is the one word people look for. */}
            {status === 'done' ? 'Open it again' : 'Bring it back now'}
          </MenuItem>
        )}
        {status !== 'done' && (
          <MenuItem disabled={busy} onClick={() => void patch({ status: 'done' })}>Done</MenuItem>
        )}
      </Dropdown>

      {error && <div className="alert alert-danger" role="alert">{error}</div>}
    </div>
  )
}
