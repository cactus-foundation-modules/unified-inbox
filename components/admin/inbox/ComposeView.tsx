'use client'

import {
  useCallback, useEffect, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { inboxHref } from '@/modules/unified-inbox/lib/list'
import { isWorthSaving, splitAddresses, type DraftForComposer } from '@/modules/unified-inbox/lib/drafts'
import { AttachmentChips, AttachmentPicker, plainReason, toHtml, type Attachment } from './AttachmentPicker'
import { AttachmentDropNotice, AttachmentDropOverlay } from './AttachmentDropChrome'
import { useAttachmentDrop } from './useAttachmentDrop'
import { ConfirmDialog } from './ConfirmDialog'
import { RecipientField } from './RecipientField'
import { CloseIcon } from './icons'

// Writing a brand new message, rather than answering one somebody else started.
//
// It opens over the inbox rather than in place of it: starting a message is
// something you do while looking at the list, not somewhere you go instead of
// it, and the conversations stay where they were for when it closes. A reply is
// the other case entirely and stays under the conversation it answers, where the
// message being answered is on screen above it.
//
// Once the message has gone, what you are looking at IS a conversation, so the
// browser is sent straight to it.
//
// The address it goes out as is a menu rather than a fixed value. It opens on
// whichever inbox the list is showing, which is what somebody means by "write a
// new one" from inside accounts@, but a note to a supplier that ought to come
// from marcus@ is one click away rather than a trip through the settings. Only
// inboxes this person may actually send from are in the menu: offering an
// address the send route would then refuse is a worse answer than not offering
// it (D16).
//
// Save rather than Send puts the whole screenful down as a draft and leaves it
// under the Drafts tab. What is stored is what was typed, not the HTML it
// would have become, so opening it again gives back the same box with the same
// line breaks in it.

export type ComposeInbox = { id: string; name: string; address: string }

/** Everything the keyboard can land on inside the card. Used to work out where
 *  the ends of the dialog are, so Tab goes round in a circle rather than out of
 *  it and into the inbox underneath. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** A click that was always going to open somewhere else: a new tab, a new
 *  window, a download. Nothing is lost by letting one through, and asking "are
 *  you sure" about a click that never closed anything is the sort of question
 *  that teaches people to click straight past the ones that matter. */
function opensElsewhere(event: ReactMouseEvent<HTMLAnchorElement>): boolean {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
}

type Props = {
  base: string
  params: Record<string, string>
  inboxes: ComposeInbox[]
  /** Which one the menu opens on, worked out on the server from the open tab. */
  defaultInboxId: string | null
  /** The draft being finished, when the address named one. */
  draft: DraftForComposer | null
}

export function ComposeView({ base, params, inboxes, defaultInboxId, draft }: Props) {
  const router = useRouter()
  const [inboxId, setInboxId] = useState(draft?.inboxId ?? defaultInboxId ?? '')
  const [to, setTo] = useState((draft?.to ?? []).join(', '))
  const [cc, setCc] = useState((draft?.cc ?? []).join(', '))
  const [showCc, setShowCc] = useState((draft?.cc ?? []).length > 0)
  const [subject, setSubject] = useState(draft?.subject ?? '')
  const [text, setText] = useState(draft?.body ?? '')
  const [attachments, setAttachments] = useState<Attachment[]>(
    (draft?.attachments ?? []).map((file) => ({ ...file, sizeBytes: file.sizeBytes ?? null })),
  )
  const [picking, setPicking] = useState(false)
  // Which job is in flight, rather than merely that one is: a button that says
  // "Saving..." while somebody is sending is a button telling a small lie.
  const [busyWith, setBusyWith] = useState<'send' | 'save' | 'discard' | null>(null)
  const busy = busyWith !== null
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  // Which question is on screen: leaving with something unsaved, or throwing a
  // saved draft away. Two different losses, two different sentences.
  const [asking, setAsking] = useState<'leave' | 'discard' | null>(null)
  // Held rather than read from the address, because the first save mints it and
  // the second must land on the same row - four presses of Save are one draft.
  const [draftId, setDraftId] = useState<string | null>(draft?.id ?? null)
  // Typed since the last time any of it was put down somewhere. Deliberately
  // not "is there text": text that has just been saved is not at risk.
  const [dirty, setDirty] = useState(false)

  /** A file dragged onto the dialog, rather than found in the library. The
   *  whole card is the target, not just the box: somebody dragging a quote at
   *  a new message is aiming at the message, and asking them to hit a
   *  particular rectangle inside it is asking them to aim twice. */
  const drop = useAttachmentDrop({
    disabled: busy,
    onAttached: (item) => {
      setAttachments((prev) => (prev.some((a) => a.key === item.key) ? prev : [...prev, item]))
      setDirty(true)
    },
  })

  // One token per screenful, exactly as the reply composer carries: a double
  // press, or a retry after a timeout that may or may not have arrived, is one
  // email rather than two (E14). Nothing regenerates it here, because a message
  // that has genuinely gone leaves this screen altogether.
  const token = useRef(crypto.randomUUID())

  // The token stops the SERVER acting twice. This stops the browser asking
  // twice: state has not come back round by the time a second click lands in
  // the same frame, so the disabled button is not on its own enough.
  const inFlight = useRef(false)

  const closeHref = inboxHref(base, params, {})
  const chosen = inboxes.find((i) => i.id === inboxId) ?? null

  const card = useRef<HTMLDivElement>(null)

  const hasUnsaved = dirty && (
    to.trim().length > 0
    || cc.trim().length > 0
    || subject.trim().length > 0
    || text.trim().length > 0
    || attachments.length > 0
  )

  const leave = useCallback(() => { router.push(closeHref) }, [closeHref, router])

  /** Every way out that is not Send: Escape, the cross, Cancel. Half a written
   *  message is not something to lose to one keystroke, so when there is
   *  something to lose the question is asked first. */
  const askToLeave = useCallback(() => {
    if (hasUnsaved) setAsking('leave')
    else leave()
  }, [hasUnsaved, leave])

  // Read out of a box so the listener below can be put on the page once and
  // left there, rather than being torn down and rebuilt on every keystroke.
  const leaveRef = useRef(askToLeave)
  useEffect(() => { leaveRef.current = askToLeave })

  // A dialog is a dialog: Escape shuts it, the page behind it does not scroll
  // under it, and the keyboard starts in the box rather than back at the top of
  // the admin. Nothing shuts it by accident though - the backdrop is deaf on
  // purpose, because a stray click that loses a half-written email is a worse
  // bargain than one more click on Cancel. Escape is the same bargain and gets
  // the same answer: it asks first whenever there is anything to lose.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // Whoever it is going to, which is the first thing anybody types. A fresh
    // message opens there; one being finished opens on what it says instead.
    const first = card.current?.querySelector<HTMLElement>(
      draft?.id ? '#uin-new-text' : '#uin-new-to',
    )
    first?.focus()
    return () => { document.body.style.overflow = previous }
  }, [draft?.id])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Whatever is on top of this owns the keyboard. The confirm dialog stops
      // Escape reaching here itself; Tab it leaves alone, so it is stopped here.
      if (asking) return
      if (event.key === 'Escape') {
        event.preventDefault()
        leaveRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const inside = card.current
      if (!inside) return
      const items = Array.from(inside.querySelectorAll<HTMLElement>(FOCUSABLE))
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return
      const active = document.activeElement
      if (!inside.contains(active)) {
        event.preventDefault()
        first.focus()
        return
      }
      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [asking])

  // Closing the tab on half a message is the one loss nothing in here can undo,
  // so the browser is asked to check. It only fires when there is something to
  // lose: a guard that fires on an empty box is a guard people learn to ignore.
  useEffect(() => {
    if (!hasUnsaved) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [hasUnsaved])

  /** Return in one of the short lines at the top moves on to the next one,
   *  which is what every mail program does and what fingers expect. It never
   *  sends: Send is a button, and a message posted by a stray Return in the To
   *  box is not a message anybody meant to send. */
  const onLineKeyDown = useCallback((nextId: string) =>
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      card.current?.querySelector<HTMLElement>(`#${nextId}`)?.focus()
    }, [])

  const submit = useCallback(async () => {
    if (!inboxId) {
      setError('Pick which of your addresses this should come from.')
      return
    }
    const recipients = splitAddresses(to)
    if (recipients.length === 0) {
      setError('Say who this is going to.')
      return
    }
    if (!subject.trim()) {
      setError('Give the message a subject.')
      return
    }
    if (!text.trim()) {
      setError('There is nothing to send yet.')
      return
    }
    if (inFlight.current) return
    inFlight.current = true
    setBusyWith('send')
    setError('')
    try {
      const response = await fetch('/api/m/unified-inbox/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inboxId,
          mode: 'new',
          to: recipients,
          cc: splitAddresses(cc),
          subject: subject.trim(),
          bodyHtml: toHtml(text),
          attachments: attachments.map(({ key, url, filename, contentType }) => ({
            key, url, filename, contentType,
          })),
          idempotencyKey: token.current,
          draftId: draftId ?? undefined,
        }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        setError(plainReason(data?.error, 'That message could not be sent.'))
        return
      }
      // Nothing left to lose, and the guards above must not stop the screen
      // going where it is about to go.
      setDirty(false)
      // It is a conversation now, so go and stand in it - and in the inbox it
      // was filed into, which is not necessarily the one the list was showing
      // when the menu was changed.
      router.push(inboxHref(base, params, {
        id: data?.threadId ?? null,
        inbox: inboxId,
        page: null,
        compose: null,
      }))
      router.refresh()
    } catch {
      setError('The site could not be reached. Nothing was sent.')
    } finally {
      inFlight.current = false
      setBusyWith(null)
    }
  }, [attachments, base, cc, draftId, inboxId, params, router, subject, text, to])

  const save = useCallback(async () => {
    const payload = {
      id: draftId ?? undefined,
      inboxId: inboxId || null,
      mode: 'new' as const,
      to: splitAddresses(to),
      cc: splitAddresses(cc),
      subject: subject.trim() || null,
      body: text,
      attachments: attachments.map(({ key, url, filename, contentType, sizeBytes }) => ({
        key, url, filename, contentType, sizeBytes,
      })),
    }
    if (!isWorthSaving(payload)) {
      setError('There is nothing to save yet.')
      return
    }
    if (inFlight.current) return
    inFlight.current = true
    setBusyWith('save')
    setError('')
    setNote('')
    try {
      const response = await fetch('/api/m/unified-inbox/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        setError(plainReason(data?.error, 'That draft could not be saved.'))
        return
      }
      if (data?.id) setDraftId(data.id as string)
      setDirty(false)
      setNote('Saved. It is waiting under Drafts.')
      // The Drafts tab carries a count, and it is drawn on the server.
      router.refresh()
    } catch {
      setError('The site could not be reached. Nothing was saved.')
    } finally {
      inFlight.current = false
      setBusyWith(null)
    }
  }, [attachments, cc, draftId, inboxId, router, subject, text, to])

  const discard = useCallback(async () => {
    if (!draftId) {
      setDirty(false)
      router.push(closeHref)
      return
    }
    if (inFlight.current) return
    inFlight.current = true
    setBusyWith('discard')
    setError('')
    try {
      await fetch(`/api/m/unified-inbox/drafts/${draftId}`, { method: 'DELETE' })
      setDirty(false)
      router.push(closeHref)
      router.refresh()
    } catch {
      setError('The site could not be reached. Nothing was thrown away.')
    } finally {
      inFlight.current = false
      setBusyWith(null)
    }
  }, [closeHref, draftId, router])

  return (
    <div className="uin-modal">
      <div
        className="uin-modal-card uin-modal-card-compose uin-droppable"
        role="dialog"
        aria-modal="true"
        aria-labelledby="uin-compose-title"
        ref={card}
        {...drop.dropProps}
      >
        <AttachmentDropOverlay dragging={drop.dragging} />
        <div className="uin-modal-head">
          <h2 className="uin-modal-title" id="uin-compose-title">
            {draftId ? 'A message you started' : 'A new message'}
          </h2>
          <Link
            className="uin-modal-close"
            href={closeHref}
            aria-label="Close without sending"
            onClick={(event) => {
              if (!hasUnsaved || opensElsewhere(event)) return
              event.preventDefault()
              setAsking('leave')
            }}
          >
            {CloseIcon}
          </Link>
        </div>

        <div className="uin-modal-body">
          <div className="uin-composer">
            {/* Who it is from, who it is to and what it is about are four short
                answers, so they are four short lines with the label beside the
                box rather than above it. Stacked, they ate half the box before
                anybody had written a word, and the message is what the message
                is for. */}
            <div className="uin-fields">
              <div className="uin-field-row">
                <label htmlFor="uin-new-from">From</label>
                <div className="uin-field-control">
                  <select
                    id="uin-new-from"
                    value={inboxId}
                    onChange={(e) => { setInboxId(e.target.value); setDirty(true); setError(''); setNote('') }}
                  >
                    {inboxes.map((inbox) => (
                      <option key={inbox.id} value={inbox.id}>
                        {inbox.name} ({inbox.address})
                      </option>
                    ))}
                  </select>
                  {chosen && (
                    <span className="uin-field-hint">
                      Replies land back in {chosen.name}.
                    </span>
                  )}
                </div>
              </div>

              <div className="uin-field-row">
                <label htmlFor="uin-new-to">To</label>
                <div className="uin-field-control">
                  <RecipientField
                    id="uin-new-to"
                    value={to}
                    onChange={(next) => { setTo(next); setDirty(true) }}
                    inboxId={inboxId || null}
                    onEnter={onLineKeyDown(showCc ? 'uin-new-cc' : 'uin-new-subject')}
                    placeholder="name@example.com, somebody.else@example.com"
                  />
                  {!showCc && (
                    <button type="button" className="uin-field-add" onClick={() => setShowCc(true)}>
                      Cc
                    </button>
                  )}
                </div>
              </div>

              {showCc && (
                <div className="uin-field-row">
                  <label htmlFor="uin-new-cc">Cc</label>
                  <div className="uin-field-control">
                    <RecipientField
                      id="uin-new-cc"
                      value={cc}
                      onChange={(next) => { setCc(next); setDirty(true) }}
                      inboxId={inboxId || null}
                      onEnter={onLineKeyDown('uin-new-subject')}
                      placeholder="somebody.else@example.com"
                    />
                    {/* Only while it is empty: a line with an address on it is
                        taken away by clearing it, and a button that quietly
                        dropped somebody off the message would be worse. */}
                    {!cc.trim() && (
                      <button
                        type="button"
                        className="uin-field-add"
                        onClick={() => setShowCc(false)}
                        aria-label="Take the Cc line off"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              )}

              <div className="uin-field-row">
                <label htmlFor="uin-new-subject">Subject</label>
                <div className="uin-field-control">
                  <input
                    id="uin-new-subject"
                    type="text"
                    value={subject}
                    onChange={(e) => { setSubject(e.target.value); setDirty(true) }}
                    onKeyDown={onLineKeyDown('uin-new-text')}
                    placeholder="What it is about"
                    autoComplete="off"
                  />
                </div>
              </div>
            </div>

            <div className="uin-compose-message">
              <label className="sr-only" htmlFor="uin-new-text">Your message</label>
              <textarea
                id="uin-new-text"
                value={text}
                onChange={(e) => { setText(e.target.value); setDirty(true); setNote('') }}
                placeholder="Write your message"
              />
            </div>

            <div className="uin-composer-row">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setPicking(true)}
                disabled={busy}
              >
                Attach a file
              </button>
              <AttachmentChips
                attachments={attachments}
                disabled={busy}
                onRemove={(key) => {
                  setAttachments((prev) => prev.filter((p) => p.key !== key))
                  setDirty(true)
                }}
              />
              <span className="uin-recipients">or drag one onto this message</span>
            </div>

            <AttachmentDropNotice
              progress={drop.progress}
              errors={drop.errors}
              dismissErrors={drop.dismissErrors}
            />

            {error && <div className="alert alert-danger" role="alert">{error}</div>}
            {note && !error && <div className="alert alert-success" role="status">{note}</div>}

            <div className="uin-composer-row">
              <button type="button" className="btn btn-primary btn-sm" onClick={submit} disabled={busy}>
                {busyWith === 'send' ? 'Sending...' : 'Send'}
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={save} disabled={busy}>
                {busyWith === 'save' ? 'Saving...' : 'Save as a draft'}
              </button>
              {draftId ? (
                <button
                  type="button"
                  className="uin-chip"
                  onClick={() => setAsking('discard')}
                  disabled={busy}
                >
                  {busyWith === 'discard' ? 'Throwing it away...' : 'Throw the draft away'}
                </button>
              ) : (
                <Link
                  className="uin-chip"
                  href={closeHref}
                  onClick={(event) => {
                    if (!hasUnsaved || opensElsewhere(event)) return
                    event.preventDefault()
                    setAsking('leave')
                  }}
                >
                  Cancel
                </Link>
              )}
            </div>

            {picking && (
              <AttachmentPicker
                onClose={() => setPicking(false)}
                onPick={(item) => {
                  setAttachments((prev) =>
                    prev.some((a) => a.key === item.key) ? prev : [...prev, item],
                  )
                  setDirty(true)
                  setPicking(false)
                }}
              />
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={asking === 'leave'}
        title="Leave this message?"
        body="What you have written is not saved anywhere yet, and closing loses it. Save it as a draft first if you want it back."
        confirmLabel="Leave it"
        cancelLabel="Keep writing"
        destructive
        onCancel={() => setAsking(null)}
        onConfirm={() => { setAsking(null); leave() }}
      />

      <ConfirmDialog
        open={asking === 'discard'}
        title="Throw this draft away?"
        body="What you have written goes with it, and there is no getting it back."
        confirmLabel="Throw it away"
        destructive
        busy={busyWith === 'discard'}
        // Held open while the request is in flight, so the answer and the
        // waiting are in the same place. On its way it takes the screen with it.
        onCancel={() => { if (busyWith !== 'discard') setAsking(null) }}
        onConfirm={() => { void discard().then(() => setAsking(null)) }}
      />
    </div>
  )
}
