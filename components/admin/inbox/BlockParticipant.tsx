'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// The way back in for somebody a channel has been asked to refuse.
//
// This used to be both halves - a red "Block them" button in the conversation
// header, and this one once the press had landed. The red half is gone. It was
// the only control up there that changed what a stranger gets when they next
// try to reach you, it sat in front of everybody all day beside the ordinary
// business of reading a conversation, and it was pressed by mistake. Refusing a
// caller happens for the same reason refusing an address does - because what
// they sent was junk - so it is now asked as the second half of marking the
// conversation as junk, where the same question is already put about email
// senders and where Cancel is the ordinary answer. See SpamButton.
//
// Letting somebody back in is the harmless half of that decision: it gives
// nothing away, it undoes itself, and somebody looking for it is looking for it
// on the conversation they blocked. So it stays here, drawn only when they are
// actually blocked - which is to say this is nowhere on the screen until
// somebody has been shut out, and unmissable afterwards.
//
// The channel decides what any of it means. On the phone it drops the call
// before anything rings; another channel might turn a sender away at the door.
// This only asks.

type Props = {
  threadId: string
  /** What the channel calls itself, for a line that names it. */
  channelLabel: string
}

export function BlockParticipant({ threadId, channelLabel }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function letThemBackIn() {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/m/unified-inbox/threads/${threadId}/block`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocked: false }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        // The channel's own words when it has any: only it knows why there is
        // nobody to unblock, and a generic sentence here would throw that
        // explanation away.
        setError(body?.error ?? 'That did not work.')
        return
      }
      router.refresh()
    } catch {
      setError('The site could not be reached.')
    } finally {
      setBusy(false)
    }
  }

  // Wrapped in the same row the other thread buttons sit in. Bare, it was a
  // direct child of a one-column grid and came out stretched across the whole
  // head.
  return (
    <div className="uin-thread-actions">
      <span className="uin-thread-blocked">Blocked on {channelLabel}.</span>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={busy}
        onClick={() => void letThemBackIn()}
      >
        {busy ? 'Unblocking...' : 'Unblock them'}
      </button>
      {error && <span style={{ color: 'var(--color-destructive-hover)' }} role="alert">{error}</span>}
    </div>
  )
}
