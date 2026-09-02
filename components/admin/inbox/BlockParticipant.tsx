'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ConfirmDialog } from './ConfirmDialog'

// Refuse whoever is on the other end of this conversation, from here on.
//
// It sits in the thread head rather than beside the messages, because it is
// about the conversation rather than about any one thing said in it. What
// already happened stays exactly where it is: blocking somebody and clearing
// their history are different decisions, and the second one has its own button.
//
// The channel decides what blocking means. On the phone it drops the call
// before anything rings; another channel might turn a sender away at the door.
// This only asks.

type Props = {
  threadId: string
  /** Whether they are blocked right now, so the button offers the right one of
   *  the two rather than making somebody press it to find out. */
  blocked: boolean
  /** What the channel calls itself, for a question that names it. */
  channelLabel: string
}

export function BlockParticipant({ threadId, blocked, channelLabel }: Props) {
  const router = useRouter()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function set(next: boolean) {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/m/unified-inbox/threads/${threadId}/block`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocked: next }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        // The channel's own words when it has any: only it knows why there is
        // nobody to block - a withheld number, most often - and a generic
        // sentence here would throw that explanation away.
        setError(body?.error ?? 'That did not work.')
        return
      }
      setAsking(false)
      router.refresh()
    } catch {
      setError('The site could not be reached.')
    } finally {
      setBusy(false)
    }
  }

  // Unblocking gives nothing away and undoes itself, so it just happens.
  // Blocking is the one that changes what the next caller hears, so it asks.
  if (blocked) {
    return (
      <>
        <button
          type="button"
          className="uin-chip"
          disabled={busy}
          onClick={() => void set(false)}
        >
          {busy ? 'Unblocking...' : 'Unblock them'}
        </button>
        {error && <span style={{ color: 'var(--color-destructive-hover)' }} role="alert">{error}</span>}
      </>
    )
  }

  return (
    <>
      <button type="button" className="uin-chip" disabled={busy} onClick={() => setAsking(true)}>
        Block them
      </button>
      {error && <span style={{ color: 'var(--color-destructive-hover)' }} role="alert">{error}</span>}
      <ConfirmDialog
        open={asking}
        title="Block them?"
        body={`They will not get through on ${channelLabel} again until you say so. Nothing here is deleted - this conversation and everything in it stays exactly as it is.`}
        confirmLabel="Block them"
        destructive
        busy={busy}
        onCancel={() => { if (!busy) { setAsking(false); setError('') } }}
        onConfirm={() => void set(true)}
      />
    </>
  )
}
