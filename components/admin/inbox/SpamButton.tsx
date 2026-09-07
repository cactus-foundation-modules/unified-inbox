'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ConfirmDialog } from './ConfirmDialog'
import { SpamIcon } from './icons'

// ---------------------------------------------------------------------------
// "This is junk."
//
// One press, two decisions, and keeping them apart is the whole design of this
// button.
//
// THE FIRST DECISION IS ONE PERSON'S and it happens on the press. The
// conversation goes into a Spam folder: off that person's lists, out of their
// counts, and nobody else's screen changes. The supplier newsletter one
// colleague files as junk is the one another reads every Tuesday, so it is an
// opinion rather than a fact about the mail. Nothing is deleted - press it
// again and it comes straight back.
//
// WHOSE folder is worked out on the server (see spamOwnerFor), and it is not
// always the person pressing. Junk in a SHARED address - sales@, accounts@ -
// goes into your own bin, because the address belongs to the team and the
// opinion is yours. Junk in a COLLEAGUE'S OWN address goes into THEIRS: somebody
// covering Sam's post while Sam is away is clearing Sam's inbox on Sam's
// behalf, and their own spam folder is for their own post rather than for a
// fortnight of somebody else's. `ownerName` is how the button says so, because
// "moved to Sam's spam" and "moved to your spam" are different sentences and a
// colleague deserves the one that is true.
//
// THE SECOND DECISION IS THE SITE'S, so it is asked rather than assumed. Once
// the conversation is out of the way, the dialog asks whether this sender should
// be turned away in future - and that one covers every address the site has,
// because a block that only covered the inbox you happened to be standing in is
// not a block. Cancel is the ordinary answer and leaves the front door where it
// was.
//
// The order matters. The move happens FIRST and does not wait for an answer, so
// somebody who reads the question, decides they cannot be bothered and presses
// Escape has still done the thing they pressed the button for. A dialog that
// gated both decisions on one Yes would mean cancelling put the junk back.
//
// It is drawn as a basket rather than a "no entry" sign on purpose: the basket
// is the press, and the sign is the question it asks afterwards.
// ---------------------------------------------------------------------------

type Props = {
  threadId: string
  /** Whether it is already in the relevant bin - which is the OWNER's bin, not
   *  necessarily this reader's. Decides which of the two the button offers, so
   *  nobody has to press it to find out, and so a coverer can put back
   *  something the owner binned. */
  spam: boolean
  /** The colleague whose spam folder this would land in, when that is not the
   *  reader's own. Null on your own post and on every shared address, where the
   *  button means exactly what it looks like and needs no explaining. */
  ownerName: string | null
  /** Who wrote it, normalised, or null where there is nobody to block - a
   *  discussion between colleagues, a caller who withheld their number, a
   *  channel that deals in phone numbers rather than addresses. The move still
   *  works; only the question afterwards is missing. */
  senderAddress: string | null
  /** Whether that address is already refused site-wide, in which case there is
   *  nothing to ask. */
  senderBlocked: boolean
  /** Whether this reader may shut the site's front door at all. Marking
   *  something as junk is a thing anybody who can read the conversation may do
   *  to their own screen; blocking a sender changes what happens to everybody,
   *  so it takes the same grant as answering one. */
  canBlock: boolean
  /** Greyed out while a sibling control in the same row is saving, so the row
   *  behaves as one thing. */
  disabled?: boolean
}

export function SpamButton({
  threadId, spam, ownerName, senderAddress, senderBlocked, canBlock, disabled = false,
}: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState('')

  /** Whether there is a second decision to put to anybody once the first one is
   *  done. Worked out here rather than in the handler so the two places that
   *  need the answer cannot drift apart. */
  const worthAsking = canBlock && !!senderAddress && !senderBlocked

  const setSpam = useCallback(async (next: boolean): Promise<boolean> => {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/m/unified-inbox/threads/${threadId}/spam`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spam: next }),
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

  const block = useCallback(async () => {
    if (!senderAddress) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/m/unified-inbox/blocked-senders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: senderAddress, blocked: true }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        // Kept on the screen after the dialog shuts. The move already happened
        // and did not fail; what failed is the door, and saying so where the
        // button is means it is still readable once the dialog is gone.
        setError(body?.error ?? 'They were not blocked.')
        return
      }
    } catch {
      setError('The site could not be reached, so nobody was blocked.')
    } finally {
      setBusy(false)
      setAsking(false)
      router.refresh()
    }
  }, [router, senderAddress])

  const mark = useCallback(async () => {
    if (!(await setSpam(true))) return
    // The move is done. Ask about the door only where there is a door to ask
    // about - and hold the refresh until the question is answered, since a
    // refresh mid-dialog would redraw the pane the dialog is anchored to.
    if (worthAsking) setAsking(true)
    else router.refresh()
  }, [router, setSpam, worthAsking])

  const unmark = useCallback(async () => {
    if (await setSpam(false)) router.refresh()
  }, [router, setSpam])

  // Taking something back out gives nothing away and undoes itself, so it just
  // happens. Putting it in is the press that asks the second question.
  return (
    <>
      <button
        type="button"
        className="uin-icon-btn uin-icon-btn-framed"
        disabled={busy || disabled}
        aria-pressed={spam}
        title={spam
          ? (ownerName ? `Not junk - take it out of ${ownerName}'s spam` : 'Not junk')
          : (ownerName ? `Junk - goes to ${ownerName}'s spam` : 'Junk')}
        onClick={() => void (spam ? unmark() : mark())}
      >
        {SpamIcon}
        <span className="sr-only">
          {spam
            ? `Take this out of ${ownerName ? `${ownerName}'s` : 'your'} spam folder`
            : `Move this to ${ownerName ? `${ownerName}'s` : 'your'} spam folder`}
        </span>
      </button>

      <ConfirmDialog
        open={asking}
        title="Block them as well?"
        body={<>
          {ownerName
            ? <>It is in {ownerName}&rsquo;s spam folder now - this is their own post, so it goes
                in their bin rather than yours. Nobody else&rsquo;s view of it has changed.</>
            : <>It is in your spam folder now, and nobody else&rsquo;s view of it has changed.</>}
          {' '}
          Would you also like to turn <strong>{senderAddress}</strong> away in future? Nothing
          further from them would be collected into any inbox on this site - shared or personal -
          and nothing already here would be touched. You can let them back in from the inbox
          settings.
        </>}
        confirmLabel="Block them"
        cancelLabel="No, just move it"
        destructive
        busy={busy}
        onCancel={() => {
          if (busy) return
          setAsking(false)
          // Still refreshed: the move happened whichever way this was answered.
          router.refresh()
        }}
        onConfirm={() => void block()}
      />

      {error && (
        <span className="uin-thread-actions-error" role="alert" style={{ color: 'var(--color-destructive-hover)' }}>
          {error}
        </span>
      )}
    </>
  )
}
