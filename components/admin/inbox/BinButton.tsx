'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AdminTooltip } from '@/components/admin/Tooltip'
import { useOfferUndo } from './UndoProvider'
import { BinIcon } from './icons'

// ---------------------------------------------------------------------------
// "Delete this."
//
// The basket, immediately to the left of the junk sign, because the two are
// different acts and a screen with only one of them makes people use the wrong
// one. Marking something as junk says "do not show me this sort of post"; the
// bin says "I am finished with this particular conversation". People reached
// for the junk button for both, which slowly filled a spam folder with things
// that were not spam and made the folder useless for the job it does have.
//
// WHOSE bin is worked out on the server (see binOwnerFor, which is the junk
// rule under a second name), and it is not always the person pressing.
// Something deleted out of a SHARED address goes into your own bin, because the
// address belongs to the team and the decision is yours. Something deleted out
// of a COLLEAGUE'S OWN address goes into THEIRS: somebody covering Sam's post
// while Sam is away is clearing Sam's inbox on Sam's behalf, and the folder
// under Sam's name on the rail is where it can be found again. `ownerName` is
// how the button says so, because "moved to Sam's bin" and "moved to your bin"
// are different sentences and a colleague deserves the one that is true.
//
// NOTHING IS DESTROYED BY THIS PRESS, which is why - unlike the junk button
// beside it - it asks nothing and simply does it. It moves the conversation to
// a bin and offers five seconds in which that was still a mistake, exactly as
// marking one done and snoozing one do. The press that genuinely throws
// something away is "Empty bin", which lives in the Bin folder, asks first, and
// says in plain English what it is about to do.
//
// And nothing here touches a mail server, ever. Deleting a conversation on this
// site deletes it on this site; the message stays where it is in whatever
// mailbox it came from.
// ---------------------------------------------------------------------------

type Props = {
  threadId: string
  /** Whether it is already in the relevant bin - which is the OWNER's bin, not
   *  necessarily this reader's. Decides which of the two the button offers, so
   *  nobody has to press it to find out, and so a coverer can put back
   *  something the owner deleted. */
  binned: boolean
  /** The colleague whose bin this would land in, when that is not the reader's
   *  own. Null on your own post and on every shared address, where the button
   *  means exactly what it looks like and needs no explaining. */
  ownerName: string | null
  /** Where the list is without this conversation open on it - the same address
   *  the close cross points at. Deleting something takes it out of every list
   *  the reader could have been standing in, so the conversation under their
   *  eyes is one that is no longer anywhere: the pane goes back to "Nothing
   *  open" rather than holding a thread the list beside it has dropped. */
  closeHref: string
  /** Greyed out while a sibling control in the same row is saving, so the row
   *  behaves as one thing. */
  disabled?: boolean
}

export function BinButton({ threadId, binned, ownerName, closeHref, disabled = false }: Props) {
  const router = useRouter()
  const offerUndo = useOfferUndo()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const setBinned = useCallback(async (next: boolean): Promise<boolean> => {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/m/unified-inbox/threads/${threadId}/bin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bin: next }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? 'That did not save.')
        return false
      }
      return true
    } catch {
      setError('The site could not be reached, so nothing changed.')
      return false
    } finally {
      setBusy(false)
    }
  }, [threadId])

  /** Into the bin, and the five seconds in which that was still a mistake.
   *
   *  Raised through the provider rather than drawn here, because this button is
   *  inside the pane the press has just shut - a toast left in it would go with
   *  it. A bare request in the undo for the same reason: the redraw is the
   *  provider's job. */
  const remove = useCallback(async () => {
    if (!(await setBinned(true))) return
    offerUndo({
      message: ownerName ? `Moved to ${ownerName}'s bin.` : 'Moved to the bin.',
      undo: async () => {
        await fetch(`/api/m/unified-inbox/threads/${threadId}/bin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bin: false }),
        })
      },
    })
    router.push(closeHref)
  }, [closeHref, offerUndo, ownerName, router, setBinned, threadId])

  // Out of the bin is the same kind of move as into it: the conversation leaves
  // the folder it is being read in, so the reader goes back to the list rather
  // than sitting in front of something that is no longer on it.
  const restore = useCallback(async () => {
    if (await setBinned(false)) router.push(closeHref)
  }, [closeHref, router, setBinned])

  // The word, for the tooltip and for nothing else - the button is a drawing
  // with no writing on it, and a drawing nobody can read is one nobody presses.
  const word = binned
    ? (ownerName ? `Put it back into ${ownerName}'s post` : 'Put it back')
    : (ownerName ? `Delete - goes to ${ownerName}'s bin` : 'Delete')

  return (
    <>
      {/* The admin's own tooltip rather than `title=`: the native one waits a
          second before it says anything and never appears for a keyboard. */}
      <AdminTooltip body={word}>
        <button
          type="button"
          className="uin-icon-btn uin-icon-btn-framed"
          disabled={busy || disabled}
          aria-pressed={binned}
          onClick={() => void (binned ? restore() : remove())}
        >
          {BinIcon}
          <span className="sr-only">
            {binned
              ? `Take this out of ${ownerName ? `${ownerName}'s` : 'your'} bin`
              : `Move this to ${ownerName ? `${ownerName}'s` : 'your'} bin. Nothing is destroyed until the bin is emptied.`}
          </span>
        </button>
      </AdminTooltip>

      {error && (
        <span className="uin-thread-actions-error" role="alert" style={{ color: 'var(--color-destructive-hover)' }}>
          {error}
        </span>
      )}
    </>
  )
}
