'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ConfirmDialog } from './ConfirmDialog'

// Taking a merged conversation apart again.
//
// It used to be a panel in the conversation's header - a titled box saying
// "Another conversation was merged into this one", the subject that was folded
// in, who did it and when, and a button. Which is a permanent band of furniture
// across the top of every conversation anybody has ever merged, repeating a
// fact the timeline underneath already records, in front of the messages
// somebody actually opened the conversation to read.
//
// So it moved to where that fact already was. "Chris merged it with another"
// sits in What has been done to this, with the date beside it, and the way back
// out is a button on the end of that line. Nobody has to be told a conversation
// was merged before they can read it; whoever wants to know goes to the log,
// which is where the rest of the history lives.
//
// Only drawn for whoever may manage the addresses, because they are the only
// ones the undo would work for - the server decides that (see InboxPanel, which
// only asks for the merges when it would be allowed) and a button that refuses
// everybody who presses it is worse than no button.

export type ThreadMergeView = {
  /** The merge, not the conversation - it is the merge that gets undone. */
  id: string
  subject: string | null
}

export function UnmergeButton({ merge }: { merge: ThreadMergeView }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [asking, setAsking] = useState(false)

  const undo = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/m/unified-inbox/threads/merges/${merge.id}/undo`, {
        method: 'POST',
      })
      if (!response.ok) {
        setError((await response.json().catch(() => null))?.error ?? 'That could not be put back.')
        return
      }
      router.refresh()
    } catch {
      setError('The site could not be reached, so nothing changed.')
    } finally {
      setBusy(false)
    }
  }, [merge.id, router])

  const what = merge.subject?.trim() || 'A conversation with no subject'

  return (
    <>
      <button
        type="button"
        className="uin-chip uin-log-undo"
        disabled={busy}
        title={`Separate "${what}" out again`}
        onClick={() => setAsking(true)}
      >
        {busy ? 'Separating...' : 'Unmerge'}
      </button>
      {error && <span className="uin-log-error" role="alert">{error}</span>}

      <ConfirmDialog
        open={asking}
        title="Separate this conversation out again?"
        body={
          <>
            <p>
              &ldquo;{what}&rdquo; goes back where it was, and everything that came in with
              it goes with it. Anything that has arrived since the merge stays here, because
              it arrived on this conversation rather than on that one.
            </p>
            <p>You can merge them again afterwards if you change your mind.</p>
          </>
        }
        confirmLabel="Separate it"
        busy={busy}
        onCancel={() => { if (!busy) setAsking(false) }}
        onConfirm={() => { setAsking(false); void undo() }}
      />
    </>
  )
}
