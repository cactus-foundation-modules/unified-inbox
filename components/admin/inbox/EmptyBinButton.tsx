'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AdminTooltip } from '@/components/admin/Tooltip'
import { ConfirmDialog } from './ConfirmDialog'
import { EmptyBinIcon } from './icons'

// ---------------------------------------------------------------------------
// The one press on this screen that genuinely throws something away.
//
// It sits between the search box and the filters, in the Bin folder alone -
// exactly where the Spam folder keeps its own errand, the list of blocked
// addresses. That is the place on this toolbar for "a thing to do about this
// folder", as opposed to the cuts on either side of it, which are things to do
// about the list.
//
// NOTHING HAPPENS ON THE PRESS. It puts up a question that says, in as few
// words as it can manage, the three facts somebody needs before they answer:
// how many conversations, that they go for everybody who could see them rather
// than out of one person's folder, and that nothing brings them back. The
// keyboard starts on Cancel, because this is the definition of the case that
// rule is for.
//
// It is offered only where there is something to empty and only to somebody who
// may empty it - the grant is `manage`, which is stricter than the grant to put
// something in a bin. Filling one hides a conversation from your own screen and
// undoes itself with the same button; emptying one takes it away from every
// colleague who could read it. Those are not the same act and they do not take
// the same permission. See the route.
//
// AND IT DOES NOT TOUCH A MAIL SERVER. What goes is this site's copy: the rows
// here and the attachments in this site's own storage. The message itself sits
// where it always sat, in whatever mailbox it was collected from, untouched.
// ---------------------------------------------------------------------------

type Props = {
  /** Which address's bin, or null for the reader's own. The folder on the rail
   *  is scoped by address - `bin:<inbox id>` - so the address is what the
   *  screen knows; the server turns it into an owner, against the addresses
   *  this reader may actually open. */
  inboxId: string | null
  /** Whose bin, when it is not the reader's own, so the question can name them.
   *  Emptying a colleague's bin is a thing a coverer can do, and it had better
   *  be obvious which of the two bins is about to go. */
  ownerName: string | null
  /** How many conversations are in it. Said in the question, because "empty the
   *  bin" and "destroy 412 conversations" are the same act described at two
   *  very different levels of honesty. */
  count: number
  /** Where the list is with nothing open on it. Everything in the folder is
   *  about to go, the conversation open beside it among them, so the pane has
   *  to be shut rather than left holding something that no longer exists. */
  closeHref: string
}

export function EmptyBinButton({ inboxId, ownerName, count, closeHref }: Props) {
  const router = useRouter()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** What a run that ran out of time got through, so the question can say so
   *  and be pressed again for the rest. A very full bin is more requests to
   *  storage than one go has, and the route stops on whole batches rather than
   *  halfway through one - see the note at the top of it. */
  const [partial, setPartial] = useState<number | null>(null)

  const empty = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/m/unified-inbox/bin/empty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inboxId }),
      })
      const body = (await response.json().catch(() => null)) as
        { error?: string; conversations?: number; more?: boolean } | null
      if (!response.ok) {
        // The dialog stays up, holding the reason. A question that closed on a
        // refusal would leave somebody looking at a bin that is still full with
        // nothing at all saying why.
        setError(body?.error ?? 'The bin could not be emptied.')
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
      setError('The site could not be reached, so nothing was emptied.')
    } finally {
      setBusy(false)
    }
  }, [closeHref, inboxId, router])

  const whose = ownerName ? `${ownerName}'s bin` : 'the bin'

  return (
    <>
      {/* The admin's own tooltip rather than `title=`: the native one waits a
          second before it says anything, never appears for a keyboard, and
          every control in this row is a drawing with no word on its face. */}
      <AdminTooltip body={ownerName ? `Empty ${ownerName}'s bin` : 'Empty the bin'}>
        <button
          type="button"
          className="uin-icon-btn"
          aria-haspopup="dialog"
          aria-expanded={asking}
          onClick={() => setAsking(true)}
        >
          {EmptyBinIcon}
          <span className="sr-only">
            Empty {whose}. This destroys everything in it for good.
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
            as putting something in the bin: {count === 1 ? 'it' : 'they'} will be gone from the
            site for <strong>everybody</strong> who could see {count === 1 ? 'it' : 'them'}, not
            only from your own screen, and there is no way to bring {count === 1 ? 'it' : 'them'} back.
          </p>
          <p>
            Nothing is touched in your mail account. Whatever arrived by email is still sitting in
            the mailbox it arrived in - this only clears what is held here.
          </p>
          {error && <p className="alert alert-danger" role="alert">{error}</p>}
        </>}
        confirmLabel={busy ? 'Emptying…' : 'Yes, empty it'}
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
