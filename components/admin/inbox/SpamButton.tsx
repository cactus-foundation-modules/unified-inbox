'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AdminTooltip } from '@/components/admin/Tooltip'
import { ConfirmDialog } from './ConfirmDialog'
import { useOfferUndo } from './UndoProvider'
import { SpamIcon } from './icons'

// ---------------------------------------------------------------------------
// "This is junk."
//
// One press, two decisions, and keeping them apart is the whole design of this
// button.
//
// THE FIRST DECISION IS ONE PERSON'S. The conversation goes into a Spam folder:
// off that person's lists, out of their counts, and nobody else's screen
// changes. The supplier newsletter one
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
// Turned away means their post lands in the Spam folder rather than in an
// inbox, marked done and left unread. It is not destroyed and it is not left on
// the mail server for somebody to go and look for: "did they ever actually
// write?" is a question this site can now answer. See migration 044.
//
// NOTHING HAPPENS ON THE PRESS. The press opens the question and that is all,
// and one of its answers is always "I did not mean to press that": the cross in
// the corner, Escape, the background and Cancel all leave the conversation
// exactly where it was. Where there is a sender to turn away there are two more
// - move it, or move it and shut the door - and where there is not there is one,
// which is the move. That last case used to skip the question entirely, so the
// one press with nothing to offer was also the one press with no way back.
//
// This is the second design. The first one moved the conversation on the press
// and asked about the door afterwards, on the grounds that somebody who cannot
// be bothered to read the question has still done the thing they pressed the
// button for. True, and no help at all to somebody whose finger slipped: the
// junk was already gone, and the only way back was to go and find it. A junk
// button is pressed next to a reply button all day long. It gets an undo.
//
// It is drawn as a "no entry" sign rather than as a waste basket. A basket is
// what mail programs draw for junk, but it is also what everything else in the
// world draws for Delete, and a control that looks like it destroys the message
// is a control people leave alone - which is how a junk button ends up
// unfindable in plain sight. The sign says refused, not destroyed, and refused
// is what the press means: nothing is deleted, and pressing it again brings the
// conversation back.
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
  /** Where the list is without this conversation open on it - the same address
   *  the close cross points at. Junking something takes it out of every list
   *  the reader could have been standing in, so the conversation under their
   *  eyes is one that is no longer anywhere: the pane goes back to "Nothing
   *  open" rather than holding a thread the list beside it has dropped. */
  closeHref: string
  /** Greyed out while a sibling control in the same row is saving, so the row
   *  behaves as one thing. */
  disabled?: boolean
}

export function SpamButton({
  threadId, spam, ownerName, senderAddress, senderBlocked, canBlock, closeHref,
  disabled = false,
}: Props) {
  const router = useRouter()
  const offerUndo = useOfferUndo()
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState('')

  /** The five seconds in which junking this was still a mistake you can take
   *  back. Raised through the provider rather than drawn here, because this
   *  button is inside the pane the press has just shut - a toast left in it
   *  would go with it. A bare request for the same reason.
   *
   *  It brings the conversation back and stops there. Where the door was shut
   *  as well, it stays shut and the toast says so: this button is not told
   *  whether the sender was ALREADY blocked before the press, so an undo that
   *  reopened the door could quietly let somebody back in who had been turned
   *  away weeks ago. Blocked senders are managed where blocked senders are
   *  managed, in the Spam folder and in the inbox settings. */
  const offerToPutBack = useCallback((blocked: boolean) => {
    offerUndo({
      message: blocked ? 'Moved to spam. The sender stays blocked.' : 'Moved to spam.',
      undo: async () => {
        await fetch(`/api/m/unified-inbox/threads/${threadId}/spam`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ spam: false }),
        })
      },
    })
  }, [offerUndo, threadId])

  /** Whether there is a SECOND decision to put alongside the first one - a
   *  sender who could be turned away, and somebody entitled to turn them away.
   *
   *  It decides which question is asked, not whether one is. The press always
   *  asks: this used to be the gate on the dialog itself, which meant the one
   *  case with nothing to offer - a sender already blocked, a conversation
   *  between colleagues, a caller with no number - was also the one case where
   *  a mis-press went straight through with no way back. */
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

  /** Move it, then shut the door, and only shut the door if the move took -
   *  blocking somebody whose message is still sitting in the inbox is a
   *  half-done job nobody asked for. */
  const moveAndBlock = useCallback(async () => {
    if (!senderAddress) return
    if (!(await setSpam(true))) { setAsking(false); return }
    setBusy(true)
    setError('')
    // Whether the door actually shut, which is not the same question as whether
    // the move took: the toast says one sentence when the sender is now blocked
    // and a different one when they are not, and only one of them is true.
    let blocked = false
    try {
      const response = await fetch('/api/m/unified-inbox/blocked-senders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: senderAddress, blocked: true }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        // The move went through; what failed is the door. Said here rather than
        // in the dialog, which is on its way out.
        setError(body?.error ?? 'It was moved, but they were not blocked.')
        return
      }
      blocked = true
    } catch {
      setError('The site could not be reached, so nobody was blocked.')
    } finally {
      setBusy(false)
      setAsking(false)
      offerToPutBack(blocked)
      router.push(closeHref)
    }
  }, [closeHref, offerToPutBack, router, senderAddress, setSpam])

  /** The middle answer: junk it and leave the front door alone. */
  const moveOnly = useCallback(async () => {
    setAsking(false)
    if (!(await setSpam(true))) return
    offerToPutBack(false)
    router.push(closeHref)
  }, [closeHref, offerToPutBack, router, setSpam])

  // Nothing moves on the press. It puts the question up and the answer does the
  // moving - every time, whether or not there is a sender to block.
  const mark = useCallback(() => setAsking(true), [])

  // Out of the bin is the same kind of move as into it: the conversation leaves
  // the folder it is being read in, so the reader goes back to the list rather
  // than sitting in front of something that is no longer on it.
  const unmark = useCallback(async () => {
    if (await setSpam(false)) router.push(closeHref)
  }, [closeHref, router, setSpam])

  // Taking something back out gives nothing away and undoes itself, so it just
  // happens. Putting it in is the press that asks the second question.
  // The word, for the tooltip and for nothing else - the button is a sign with
  // no writing on it, and a sign nobody can read is a sign nobody presses.
  const word = spam
    ? (ownerName ? `Not junk - take it out of ${ownerName}'s spam` : 'Not junk')
    : (ownerName ? `Junk - goes to ${ownerName}'s spam` : 'Junk')

  return (
    <>
      {/* The admin's own tooltip rather than `title=`: the native one waits a
          second before it says anything, never appears for a keyboard, and this
          is the one control in the row with no word on its face. */}
      <AdminTooltip body={word}>
        <button
          type="button"
          className="uin-icon-btn uin-icon-btn-framed"
          disabled={busy || disabled}
          aria-pressed={spam}
          onClick={() => { if (spam) void unmark(); else mark() }}
        >
          {SpamIcon}
          <span className="sr-only">
            {spam
              ? `Take this out of ${ownerName ? `${ownerName}'s` : 'your'} spam folder`
              : `Move this to ${ownerName ? `${ownerName}'s` : 'your'} spam folder`}
          </span>
        </button>
      </AdminTooltip>

      <ConfirmDialog
        open={asking}
        title={worthAsking ? 'Block them as well?' : 'Move it to the spam folder?'}
        body={<>
          {ownerName
            ? <>It will go into {ownerName}&rsquo;s spam folder - this is their own post, so it
                goes in their bin rather than yours. Nobody else&rsquo;s view of it changes, and
                nothing is deleted.</>
            : <>It will go into your spam folder. Nobody else&rsquo;s view of it changes, and
                nothing is deleted.</>}
          {' '}
          {worthAsking ? <>
            Would you also like to turn <strong>{senderAddress}</strong> away in future? Nothing
            further from them would reach an inbox on this site - shared or personal. It would be
            dropped straight in here instead, marked as dealt with and left unread, so you can
            still see what they sent. Nothing already here would be touched, and you can let them
            back in from the Spam folder or from the inbox settings.
          </> : <>
            {/* No door to offer: nobody to block, already blocked, or a reader
                who may not shut it. The question is worth asking anyway - it is
                the only way back from a press nobody meant. */}
            Press the same button in the Spam folder to bring it straight back.
          </>}
        </>}
        confirmLabel={worthAsking ? 'Block them' : 'Move it to spam'}
        other={worthAsking ? { label: 'No, just move it', onClick: () => void moveOnly() } : undefined}
        cancelLabel="Cancel"
        // Only where something is genuinely lost if the answer is yes. A move
        // undoes itself with the same button, so the keyboard may start on it.
        destructive={worthAsking}
        busy={busy}
        // The cross, Escape, the background and Cancel all mean the same thing
        // now: the press was a mistake, and nothing has happened yet.
        onCancel={() => { if (!busy) setAsking(false) }}
        onConfirm={() => void (worthAsking ? moveAndBlock() : moveOnly())}
      />

      {error && (
        <span className="uin-thread-actions-error" role="alert" style={{ color: 'var(--color-destructive-hover)' }}>
          {error}
        </span>
      )}
    </>
  )
}
