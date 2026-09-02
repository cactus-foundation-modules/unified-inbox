'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ConfirmDialog } from './ConfirmDialog'

// Getting rid of one message, for good, at the far end as well as here.
//
// This is its own island for the same reason RetryButton and ThreadActions are:
// ThreadPane is a server component that renders four hundred lines of somebody's
// conversation, and it should stay one. Version 0.1.25 put this control inside
// the pane and 0.1.26 made the whole pane a client component to make that build,
// which shipped the entire thread renderer to the browser to give one button a
// useState. The button is the part that needs to be interactive, so the button
// is the part that is.
//
// The first version also asked with window.confirm and reported with alert -
// which this module banned on purpose, see ConfirmDialog's own header - floated
// itself over the message body, and never refreshed, so a press either did
// nothing anybody could see or hid a row that came straight back on reload.

/** What went wrong, in words worth reading. The route already answers in plain
 *  English for the cases it can explain - a channel that will not delete this
 *  kind of message, a channel no longer installed - so those are shown as they
 *  came. Only the ones with nothing useful to say are rewritten here. */
function refusal(status: number, message: string | null): string {
  if (status === 401) return 'You have been signed out. Sign in again and it will still be here.'
  if (status === 403) return 'You are not allowed to delete from this channel.'
  if (status === 404 && !message) return 'That message is not here any more.'
  return message ?? 'That could not be deleted just now. Try again in a moment.'
}

export function DeleteMessageButton({ messageId }: { messageId: string }) {
  const router = useRouter()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function remove() {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/m/unified-inbox/messages/${messageId}`, { method: 'DELETE' })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        setError(refusal(response.status, body?.error ?? null))
        return
      }
      setAsking(false)
      // The count under the subject is written on the thread, and the list
      // beside this is server-rendered, so a refresh is what makes the page
      // agree with itself. Without it the message vanished and the count went
      // on claiming it.
      router.refresh()
    } catch {
      setError('The site could not be reached, so nothing was deleted.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={busy}
        onClick={() => setAsking(true)}
      >
        Delete
      </button>
      {/* Beside the button, in the foot the button sits in, so a whole sentence
          has room to wrap and be read. Same colour as the other refusals in
          here: --color-danger measures under AA on this ground at this size. */}
      {error && (
        <span style={{ color: 'var(--color-destructive-hover)' }} role="alert">{error}</span>
      )}
      <ConfirmDialog
        open={asking}
        title="Delete this message?"
        body="It goes from the phone company's records as well as from here, so there is no getting it back. The rest of the conversation stays."
        confirmLabel="Delete it"
        destructive
        busy={busy}
        onCancel={() => { if (!busy) { setAsking(false); setError('') } }}
        onConfirm={() => void remove()}
      />
    </>
  )
}
