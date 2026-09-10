'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ConfirmDialog } from './ConfirmDialog'

// Sending a colleague's draft out for them, from the Drafts folder under their
// name.
//
// It sends what is on the screen and nothing else: the request carries the
// draft's id and the address it is filed on, and no body at all. Whatever the
// person reading it thinks of the wording, the only two answers here are send
// it as it stands or leave it alone - which is what keeps this a decision about
// somebody's message rather than a way of putting words in their mouth.
//
// It asks first. A message leaving on somebody else's behalf cannot be called
// back, the person who wrote it is not in the room, and the button is a single
// press away from a customer reading it - so the question names them and says
// what happens.
//
// What comes back when it will not go is shown as it stands. Unlike a retry,
// every refusal on this road is written for the person standing there - the
// send route's own English sentences about addresses, permission and timers -
// and putting a stock sentence over the top of one would hide the only thing
// that says what to do next.

type Props = {
  draftId: string
  /** The address it is filed on, sent over so the server answers whose draft
   *  and which address against what this screen was looking at. */
  inboxId: string
  /** Whose writing it is, for the question. */
  ownerName: string
}

export function SendDraftForColleague({ draftId, inboxId, ownerName }: Props) {
  const router = useRouter()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function send() {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/m/unified-inbox/drafts/${draftId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inboxId }),
      })
      if (!response.ok) {
        const said = await response.json().catch(() => null) as { error?: unknown } | null
        setError(typeof said?.error === 'string' && said.error
          ? said.error
          : 'It would not go. Give it a minute and try once more.')
        return
      }
      // Back to the folder: the draft has gone from it, and leaving the reader
      // standing on a pane that no longer has anything to show would answer
      // "did that work" with an error about a missing draft.
      router.refresh()
    } catch {
      setError('The site could not be reached.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={busy}
        onClick={() => setAsking(true)}
      >
        {busy ? 'Sending...' : `Send it for ${ownerName}`}
      </button>
      {error && (
        // A plain span so a whole sentence wraps and can be read, in the darker
        // end of the destructive ramp - --color-danger measures under AA on this
        // ground at this size.
        <span style={{ color: 'var(--color-destructive-hover)' }} role="alert">{error}</span>
      )}
      <ConfirmDialog
        open={asking}
        title={`Send this for ${ownerName}?`}
        body={`It goes out exactly as it is written, from ${ownerName}'s address and signed as them. There is no getting it back, and they are not here to check it.`}
        confirmLabel="Send it"
        busy={busy}
        onCancel={() => { if (!busy) setAsking(false) }}
        onConfirm={() => { setAsking(false); void send() }}
      />
    </>
  )
}
