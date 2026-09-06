'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ConfirmDialog } from './ConfirmDialog'

// What this conversation was made of, and the way back out.
//
// A merged conversation looks exactly like an ordinary one, which is the point
// of merging - but somebody opening it a month later has no way of knowing that
// three of the messages in it were filed somewhere else until Tuesday, and a
// merge nobody can find is a merge nobody can undo. So it says so, quietly,
// under the controls: one line per conversation that was folded in, each with
// its own way back.
//
// Only shown to whoever may manage the addresses, because they are the only
// ones the undo would work for. A button that refuses everybody who presses it
// is worse than no button.

export type MergedFromView = {
  /** The merge, not the conversation - it is the merge that gets undone. */
  id: string
  subject: string | null
  /** Already words by the time it arrives: the pane around this is rendered on
   *  the server, and a Date handed to a client component turns into {}. */
  when: string
  /** Who did it, by name. Null when they have since left. */
  by: string | null
}

export function MergedFrom({ merges }: { merges: MergedFromView[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [asking, setAsking] = useState<MergedFromView | null>(null)

  const undo = useCallback(async (mergeId: string) => {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/m/unified-inbox/threads/merges/${mergeId}/undo`, {
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
  }, [router])

  if (merges.length === 0) return null

  return (
    <div className="uin-merged-from">
      <span className="uin-merged-from-title">
        {merges.length === 1
          ? 'Another conversation was merged into this one.'
          : `${merges.length} other conversations were merged into this one.`}
      </span>
      <ul className="uin-merged-from-list">
        {merges.map((merge) => (
          <li key={merge.id}>
            <span className="uin-merged-from-what">
              {merge.subject?.trim() || 'A conversation with no subject'}
            </span>
            <span className="uin-merged-from-when">
              {merge.by ? `${merge.by}, ${merge.when}` : merge.when}
            </span>
            <button
              type="button"
              className="uin-chip"
              disabled={busy}
              onClick={() => setAsking(merge)}
            >
              Separate it again
            </button>
          </li>
        ))}
      </ul>

      {error && <div className="alert alert-danger" role="alert">{error}</div>}

      <ConfirmDialog
        open={!!asking}
        title="Separate this conversation out again?"
        body={
          <>
            <p>
              Everything that came in with it goes back where it was. Anything
              that has arrived since the merge stays here, because it arrived on
              this conversation rather than on that one.
            </p>
            <p>You can merge them again afterwards if you change your mind.</p>
          </>
        }
        confirmLabel="Separate it"
        busy={busy}
        onCancel={() => setAsking(null)}
        onConfirm={() => {
          const merge = asking
          setAsking(null)
          if (merge) void undo(merge.id)
        }}
      />
    </div>
  )
}
