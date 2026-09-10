'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AdminTooltip } from '@/components/admin/Tooltip'
import { refusalMessage, runOnMany, them, useBulkTargets, useSelection } from './Selection'
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
//
// ONE PRESS, HOWEVER MANY CONVERSATIONS ARE TICKED. Somebody who has picked six
// in the list, opened one of them to check it is the right pile, and pressed
// this means the six - so this button acts on the pick beside it (see
// Selection) exactly as the bar over the list does, and says how many it moved.
// With nothing ticked it is the one conversation on the screen, which is what
// it has always been.
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

  // This conversation, and everything else ticked in the list beside it.
  const targets = useBulkTargets(threadId)
  const { clear: dropSelection } = useSelection()

  /** Says whether ANY of them moved. One request per conversation and settled
   *  rather than raced, so a single refusal does not hide five that went
   *  through - and the sentence on the screen names how many did not. */
  const setBinned = useCallback(async (next: boolean): Promise<boolean> => {
    setBusy(true)
    setError('')
    try {
      const { failed, count } = await runOnMany(targets, (id) =>
        fetch(`/api/m/unified-inbox/threads/${id}/bin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bin: next }),
        }))
      const refused = refusalMessage(failed, count)
      if (refused) setError(refused)
      return failed < count
    } catch {
      setError('The site could not be reached, so nothing changed.')
      return false
    } finally {
      setBusy(false)
    }
  }, [targets])

  /** Into the bin, and the five seconds in which that was still a mistake.
   *
   *  Raised through the provider rather than drawn here, because this button is
   *  inside the pane the press has just shut - a toast left in it would go with
   *  it. A bare request in the undo for the same reason: the redraw is the
   *  provider's job. */
  const remove = useCallback(async () => {
    // Read before the run: the pick is emptied on the way out, and the toast
    // has to offer back exactly what went.
    const ids = [...targets]
    if (!(await setBinned(true))) return
    dropSelection()
    offerUndo({
      // Whose bin it was is only said of a single conversation. A pile picked
      // off a list can span two colleagues' post, and "moved to Sam's bin" over
      // six conversations that went to three different bins is a sentence that
      // is not true.
      message: ids.length > 1
        ? `${ids.length} ${them(ids.length)} moved to the bin.`
        : ownerName ? `Moved to ${ownerName}'s bin.` : 'Moved to the bin.',
      undo: async () => {
        await Promise.allSettled(ids.map((id) => fetch(`/api/m/unified-inbox/threads/${id}/bin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bin: false }),
        })))
      },
    })
    router.push(closeHref)
  }, [closeHref, dropSelection, offerUndo, ownerName, router, setBinned, targets])

  // Out of the bin is the same kind of move as into it: the conversation leaves
  // the folder it is being read in, so the reader goes back to the list rather
  // than sitting in front of something that is no longer on it.
  const restore = useCallback(async () => {
    if (!(await setBinned(false))) return
    dropSelection()
    router.push(closeHref)
  }, [closeHref, dropSelection, router, setBinned])

  // The word, for the tooltip and for nothing else - the button is a drawing
  // with no writing on it, and a drawing nobody can read is one nobody presses.
  // How many this press would take with it, said on the tooltip rather than
  // left to be discovered afterwards: a button that quietly deletes six when it
  // looks like it deletes one is the worst button on the screen.
  const many = targets.length > 1
  const word = binned
    ? many
      ? `Put all ${targets.length} back`
      : (ownerName ? `Put it back into ${ownerName}'s post` : 'Put it back')
    : many
      ? `Delete all ${targets.length} - they go to the bin`
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
            {many
              ? binned
                ? `Take all ${targets.length} picked conversations out of the bin`
                : `Move all ${targets.length} picked conversations to the bin. Nothing is destroyed until the bin is emptied.`
              : binned
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
