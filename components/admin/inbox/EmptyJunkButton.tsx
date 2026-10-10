'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AdminTooltip } from '@/components/admin/Tooltip'
import { ConfirmDialog } from './ConfirmDialog'
import { EmptyBinIcon } from './icons'

// ---------------------------------------------------------------------------
// "Delete all", in the Spam folder: the Bin's emptying button for the junk.
//
// Sits to the left of the blocked-addresses button, the two grouped as one pill.
// Nothing happens on the press: it asks, says how many, that they go for
// everybody who could see them, and that nothing brings them back, and the
// keyboard starts on Cancel. Offered only where there is something to delete and
// only to somebody holding `manage`, for the Bin's reasons - see its button and
// the route. The sender stays blocked, and no mail server is touched.
// ---------------------------------------------------------------------------

type Props = {
  /** Which address's junk, or null for the reader's own. The folder on the rail
   *  is scoped by address - `spam:<inbox id>` - so the address is what the
   *  screen knows; the server turns it into an owner, against the addresses
   *  this reader may actually open. */
  inboxId: string | null
  /** Whose junk, when it is not the reader's own, so the question can name them.
   *  Deleting a colleague's junk is a thing a coverer can do, and it had better
   *  be obvious which of the two folders is about to go. */
  ownerName: string | null
  /** How many conversations are in it. Said in the question, because "delete all
   *  the junk" and "destroy 412 conversations" are the same act described at two
   *  very different levels of honesty. */
  count: number
  /** Where the list is with nothing open on it. Everything in the folder is
   *  about to go, the conversation open beside it among them, so the pane has
   *  to be shut rather than left holding something that no longer exists. */
  closeHref: string
}

export function EmptyJunkButton({ inboxId, ownerName, count, closeHref }: Props) {
  const router = useRouter()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** What a run that ran out of time got through, so the question can say so
   *  and be pressed again for the rest. A very full folder is more requests to
   *  storage than one go has, and the route stops on whole batches rather than
   *  halfway through one - see the note at the top of it. */
  const [partial, setPartial] = useState<number | null>(null)

  const empty = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/m/unified-inbox/spam/empty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inboxId }),
      })
      const body = (await response.json().catch(() => null)) as
        { error?: string; conversations?: number; more?: boolean } | null
      if (!response.ok) {
        // The dialog stays up, holding the reason. A question that closed on a
        // refusal would leave somebody looking at a folder that is still full with
        // nothing at all saying why.
        setError(body?.error ?? 'The junk could not be deleted.')
        return
      }
      if (body?.more) {
        // It got through what it could. The dialog stays up and says how much,
        // because the alternative is a folder that is still full after a button
        // labelled Empty, with nothing on the screen explaining it.
        setPartial(body.conversations ?? 0)
        router.refresh()
        return
      }
      setAsking(false)
      router.push(closeHref)
    } catch {
      setError('The site could not be reached, so nothing was deleted.')
    } finally {
      setBusy(false)
    }
  }, [closeHref, inboxId, router])

  const whose = ownerName ? `${ownerName}'s junk` : 'the junk folder'

  return (
    <>
      {/* The admin's own tooltip rather than `title=`: the native one waits a
          second before it says anything, never appears for a keyboard, and
          every control in this row is a drawing with no word on its face. */}
      <AdminTooltip body={ownerName ? `Delete all ${ownerName}'s junk` : 'Delete all junk'}>
        <button
          type="button"
          className="uin-icon-btn"
          aria-haspopup="dialog"
          aria-expanded={asking}
          onClick={() => setAsking(true)}
        >
          {EmptyBinIcon}
          <span className="sr-only">
            Delete all of {whose}. This destroys everything in it for good.
          </span>
        </button>
      </AdminTooltip>

      <ConfirmDialog
        open={asking}
        title={count === 1
          ? `Delete this conversation for good?`
          : `Delete all ${count.toLocaleString('en-GB')} conversations for good?`}
        body={<>
          {partial !== null && (
            <p className="alert alert-info" role="status">
              {partial.toLocaleString('en-GB')} gone so far. There was more in here than one go
              could manage, so press again to carry on with the rest.
            </p>
          )}
          <p>
            Everything in {whose} goes, along with anything attached to it. This is not the same
            as moving something to the junk folder: {count === 1 ? 'it' : 'they'} will be gone from the
            site for <strong>everybody</strong> who could see {count === 1 ? 'it' : 'them'}, not
            only from your own screen, and there is no way to bring {count === 1 ? 'it' : 'them'} back.
          </p>
          <p>
            Nothing is touched in your mail account, and anybody blocked stays blocked. Whatever
            arrived by email is still sitting in the mailbox it arrived in - this only clears what
            is held here.
          </p>
          {error && <p className="alert alert-danger" role="alert">{error}</p>}
        </>}
        confirmLabel={busy ? 'Deleting…' : 'Yes, delete all'}
        cancelLabel="Cancel"
        // The one place on this screen where the answer really does lose
        // something, so the keyboard starts on Cancel.
        destructive
        busy={busy}
        onCancel={() => { if (!busy) { setAsking(false); setError(''); setPartial(null) } }}
        onConfirm={() => void empty()}
      />
    </>
  )
}
