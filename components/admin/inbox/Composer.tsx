'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { isWorthSaving, splitAddresses, type DraftForComposer } from '@/modules/unified-inbox/lib/drafts'
import { AttachmentChips, AttachmentPicker, plainReason, toHtml, type Attachment } from './AttachmentPicker'
import { AttachmentDropNotice, AttachmentDropOverlay } from './AttachmentDropChrome'
import { useAttachmentDrop } from './useAttachmentDrop'
import { ConfirmDialog } from './ConfirmDialog'
import { SendLater } from './SendLater'
import type { DraftSendState } from '@/modules/unified-inbox/lib/types'

// The composer: reply, reply to everybody, forward, and an internal note.
//
// Almost nothing about a message is decided here. The signature, the quoted
// original, the Message-ID, the References chain and who a reply actually goes
// to all live in the module's own pure code on the server, where they are
// tested - this is a box to type in and a button to press. Sending the same
// thing twice is the one thing the browser has to help with, and it does it by
// carrying a token.

export type ComposerMode = 'reply' | 'reply-all' | 'forward' | 'note'
type Mode = ComposerMode

type StaffMember = { id: string; name: string }

/** How many colleagues are offered as chips before the list gets a box to
 *  narrow it with. Twenty names wrapped across the composer is a wall, not a
 *  menu. */
const MENTION_CHIPS = 8

type Props = {
  threadId: string
  /** Who a plain reply would go to, worked out on the server. Shown so nobody
   *  has to press Send to find out. */
  replyTo: string[]
  replyAllTo: string[]
  canReply: boolean
  canForward: boolean
  staff: StaffMember[]
  /** Left over when the inbox this conversation belongs to cannot send - no
   *  sending identity, or the person may read it but not answer it. */
  cannotReplyReason: string | null
  /** What this person left in this box last time, if they left anything. */
  draft: DraftForComposer | null
  /** Which of the three the button at the top of the conversation asked for.
   *  The chips below still change it afterwards - this only says what it opened
   *  as, and what a later press up there changed it to. */
  requestedMode?: Mode
  /** Counts those presses, so pressing Forward twice still reads as a second
   *  instruction rather than as nothing having changed. */
  requestedAt?: number
  /** The earliest a message may be set to go, in the picker's own shape and in
   *  the site's zone. Worked out on the server, because this browser may be
   *  standing somewhere else entirely. */
  minSendAt: string
  timezone: string
}

export function Composer({
  threadId, replyTo, replyAllTo, canReply, canForward, staff, cannotReplyReason, draft,
  requestedMode, requestedAt, minSendAt, timezone,
}: Props) {
  const router = useRouter()
  // A saved draft says which of the three it was, and opening the conversation
  // on the wrong one puts a forward's recipients in front of a reply. A draft
  // written before the right to send was taken away is the awkward case: the
  // mode it remembers is not on the menu any more, so no chip would read as
  // pressed and Send would be refused by the server. It falls back to a note,
  // and the explanation above the chips says why.
  const [mode, setMode] = useState<Mode>(() => {
    const wanted: Mode = requestedMode ?? (draft && draft.mode !== 'new' ? draft.mode : canReply ? 'reply' : 'note')
    if ((wanted === 'reply' || wanted === 'reply-all') && !canReply) return 'note'
    if (wanted === 'reply-all' && replyAllTo.length <= replyTo.length) return 'reply'
    if (wanted === 'forward' && !canForward) return canReply ? 'reply' : 'note'
    return wanted
  })
  const [text, setText] = useState(draft?.body ?? '')
  const [forwardTo, setForwardTo] = useState((draft?.to ?? []).join(', '))
  const [mentions, setMentions] = useState<string[]>([])
  const [mentionQuery, setMentionQuery] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>(
    (draft?.attachments ?? []).map((file) => ({ ...file, sizeBytes: file.sizeBytes ?? null })),
  )
  // Which job is in flight, rather than merely that one is: a button that says
  // "Saving..." while somebody is sending is a button telling a small lie.
  const [busyWith, setBusyWith] = useState<'send' | 'save' | 'discard' | null>(null)
  const busy = busyWith !== null
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [picking, setPicking] = useState(false)
  const [asking, setAsking] = useState(false)
  // Where a click was headed when it was caught, or null when nothing was.
  const [leavingTo, setLeavingTo] = useState<string | null>(null)
  const [draftId, setDraftId] = useState<string | null>(draft?.id ?? null)
  // When this reply is set to go out on its own, and how that went last time it
  // was tried. Held here rather than read off the draft prop each render: a
  // schedule set in this box has to show straight away, before the server has
  // redrawn the screen behind it.
  const [sendAt, setSendAt] = useState<string | null>(draft?.sendAt ?? null)
  const [sendState, setSendState] = useState<DraftSendState>(draft?.sendState ?? null)
  const [sendError, setSendError] = useState<string | null>(draft?.sendError ?? null)
  // The chase set on it, and whether mail from the recipient took the timer off
  // before it could go. Both travel with the draft rather than being worked out
  // here: the server decides what a saved schedule means.
  const [followUpMinutes, setFollowUpMinutes] = useState<number | null>(draft?.followUpMinutes ?? null)
  const [held, setHeld] = useState(draft?.held ?? false)
  // Typed since the last time any of it was put down somewhere. What the
  // beforeunload guard below is asking about, and it is deliberately not "is
  // there text", because text that has just been saved is not at risk.
  const [dirty, setDirty] = useState(false)

  // A later press of one of the buttons at the top of the conversation. Applied
  // while rendering rather than in an effect - React's own way of adjusting
  // state when a prop changes, and it saves the box drawing once in the old
  // mode before switching. Never on the first render: the box already opened as
  // that mode, and applying it again would undo a chip pressed in the same
  // breath.
  const [lastRequest, setLastRequest] = useState(requestedAt)
  if (requestedAt !== undefined && requestedAt !== lastRequest) {
    setLastRequest(requestedAt)
    if (requestedMode) setMode(requestedMode)
  }

  /** A file dragged straight onto the box, rather than found in the library.
   *  Off for an internal note, which is not sent anywhere and has nothing to
   *  carry a file on, and off while something is in flight for the reason the
   *  chips are greyed then: a message on its way is not one to add to. */
  const drop = useAttachmentDrop({
    disabled: busy || mode === 'note',
    onAttached: (item) => {
      setAttachments((prev) => (prev.some((a) => a.key === item.key) ? prev : [...prev, item]))
      setDirty(true)
    },
  })

  // One token per composer session, deliberately NOT regenerated per click: it
  // is what makes a double press, or a retry after a timeout that may or may not
  // have arrived, one message rather than two. It changes when a message has
  // genuinely been sent and the box is empty again.
  const token = useRef(crypto.randomUUID())

  // The token stops the SERVER acting twice. This stops the browser asking
  // twice: state has not come back round by the time a second click lands in
  // the same frame, so the disabled button is not on its own enough.
  const inFlight = useRef(false)

  const modes = useMemo(() => {
    const list: Array<{ id: Mode; label: string }> = []
    if (canReply) {
      list.push({ id: 'reply', label: 'Reply' })
      if (replyAllTo.length > replyTo.length) list.push({ id: 'reply-all', label: 'Reply to all' })
    }
    if (canForward) list.push({ id: 'forward', label: 'Forward' })
    list.push({ id: 'note', label: 'Internal note' })
    return list
  }, [canReply, canForward, replyTo.length, replyAllTo.length])

  const recipients = mode === 'reply' ? replyTo : mode === 'reply-all' ? replyAllTo : []
  const nobodyToReplyTo = (mode === 'reply' || mode === 'reply-all') && recipients.length === 0

  const hasUnsaved = dirty && (text.trim().length > 0 || forwardTo.trim().length > 0 || attachments.length > 0)

  // Closing the tab on half an answer is the one loss nothing in here can undo,
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

  // Read out of a box so the listener below can be put on the page once and
  // left there, rather than being rebuilt on every keystroke.
  const unsavedRef = useRef(hasUnsaved)
  useEffect(() => { unsavedRef.current = hasUnsaved })

  // The guard above only fires when the document itself is unloaded, which is
  // half of how people actually leave. The tabs along the top of the inbox are
  // links drawn by core's tab strip, so switching inbox or status is a
  // navigation the browser never unloads for: the composer is simply taken off
  // the screen, with whatever was typed in it. Nothing here saves as you go, so
  // that was the whole of it, gone, with no question asked.
  //
  // So a click on any link that would take the screen somewhere else is caught
  // first and the question asked, which is the same bargain the new-message
  // dialog strikes with its own Cancel. The tests a link has to pass to count
  // are core's, from components/admin/useUnsavedChanges: a plain left click, an
  // ordinary in-app address, and somewhere other than where we already are.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!unsavedRef.current || event.defaultPrevented) return
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest('a')
      if (!anchor) return
      // Anything drawn over the inbox owns its own way out and has already been
      // asked about: the new-message dialog guards its Cancel and its cross
      // itself, and two questions about one click is one too many.
      if (anchor.closest('.uin-modal')) return
      const href = anchor.getAttribute('href')
      if (!href || href.startsWith('#') || anchor.target === '_blank') return
      const url = new URL(anchor.href, window.location.href)
      if (url.origin !== window.location.origin) return
      if (url.pathname === window.location.pathname && url.search === window.location.search) return
      event.preventDefault()
      setLeavingTo(url.pathname + url.search + url.hash)
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])

  const submit = useCallback(async () => {
    if (!text.trim()) {
      setError('There is nothing to send yet.')
      return
    }
    if ((mode === 'reply' || mode === 'reply-all')
      && (mode === 'reply' ? replyTo : replyAllTo).length === 0) {
      setError('There is nobody to reply to on this conversation.')
      return
    }
    if (inFlight.current) return
    inFlight.current = true
    setBusyWith('send')
    setError('')
    try {
      if (mode === 'note') {
        const response = await fetch(`/api/m/unified-inbox/threads/${threadId}/notes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, mentions }),
        })
        if (!response.ok) {
          setError(plainReason(
            (await response.json().catch(() => null))?.error,
            'That note could not be saved.',
          ))
          return
        }
      } else {
        const to = mode === 'forward'
          ? forwardTo.split(/[,;]/).map((a) => a.trim()).filter(Boolean)
          : undefined
        if (mode === 'forward' && (!to || to.length === 0)) {
          setError('Say who to forward it to.')
          return
        }
        const response = await fetch('/api/m/unified-inbox/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            threadId,
            mode,
            to,
            bodyHtml: toHtml(text),
            attachments: attachments.map(({ key, url, filename, contentType }) => ({
              key, url, filename, contentType,
            })),
            includeOriginalAttachments: mode === 'forward',
            idempotencyKey: token.current,
            draftId: draftId ?? undefined,
          }),
        })
        if (!response.ok) {
          setError(plainReason(
            (await response.json().catch(() => null))?.error,
            'That message could not be sent.',
          ))
          return
        }
      }
      setText('')
      setForwardTo('')
      setAttachments([])
      setMentions([])
      setMentionQuery('')
      setDirty(false)
      // The draft went with the message, and so did any time on it.
      setSendAt(null)
      setSendState(null)
      setSendError(null)
      // Said out loud, because the box emptying could as easily mean something
      // went wrong as mean it went.
      setNote(mode === 'note' ? 'Your note is on the conversation.' : 'Sent. It is on the conversation above.')
      // The message has gone, so the draft behind it went with it - server
      // side, in the send route, rather than as a second request from here
      // that a closed tab could swallow.
      setDraftId(null)
      token.current = crypto.randomUUID()
      router.refresh()
    } catch {
      setError('The site could not be reached. Nothing was sent.')
    } finally {
      inFlight.current = false
      setBusyWith(null)
    }
  }, [attachments, draftId, forwardTo, mentions, mode, replyAllTo, replyTo, router, text, threadId])

  /** Puts the box down as a draft, with or without a time on it. Saving and
   *  scheduling are one request on purpose: a scheduled message IS a draft with
   *  a departure time, and two requests would leave a window where the writing
   *  was saved and the time was not. `wallClock` null takes a time back off. */
  const save = useCallback(async (wallClock?: string | null, followUp?: number | null) => {
    const payload = {
      id: draftId ?? undefined,
      threadId,
      mode: mode === 'note' ? ('reply' as const) : mode,
      to: mode === 'forward' ? splitAddresses(forwardTo) : [],
      cc: [],
      subject: null,
      body: text,
      attachments: attachments.map(({ key, url, filename, contentType, sizeBytes }) => ({
        key, url, filename, contentType, sizeBytes,
      })),
      // Undefined is dropped by JSON.stringify, which is exactly what "leave
      // whatever time is on it" has to look like on the wire. A string sets a
      // time, null takes it off.
      sendAt: wallClock,
      // Read by the server only when a time is being set, and cleared with the
      // time when one is taken off.
      followUpMinutes: followUp ?? null,
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
      // What came back rather than what was asked for: the server is the one
      // that decides what a typed time means.
      const at = typeof data?.sendAt === 'string' ? data.sendAt : null
      setSendAt(at)
      setSendState(at ? 'scheduled' : null)
      setSendError(null)
      setFollowUpMinutes(typeof data?.followUpMinutes === 'number' ? data.followUpMinutes : null)
      // Saving with a time on it stands the message back up: whatever mail held
      // it has been read by whoever is scheduling it again.
      if (at) setHeld(false)
      setDirty(false)
      setNote(at
        ? 'Saved, and set to go out on its own.'
        : 'Saved. It is waiting under Drafts, and here.')
      router.refresh()
    } catch {
      setError('The site could not be reached. Nothing was saved.')
    } finally {
      inFlight.current = false
      setBusyWith(null)
    }
  }, [attachments, draftId, forwardTo, mode, router, text, threadId])

  const discard = useCallback(async () => {
    if (!draftId) return
    if (inFlight.current) return
    inFlight.current = true
    setBusyWith('discard')
    setError('')
    try {
      await fetch(`/api/m/unified-inbox/drafts/${draftId}`, { method: 'DELETE' })
      setDraftId(null)
      setText('')
      setForwardTo('')
      setAttachments([])
      setSendAt(null)
      setSendState(null)
      setSendError(null)
      setDirty(false)
      setNote('')
      router.refresh()
    } catch {
      setError('The site could not be reached. Nothing was thrown away.')
    } finally {
      inFlight.current = false
      setBusyWith(null)
    }
  }, [draftId, router])

  // Whoever is already picked stays on screen whatever is typed, so a name
  // cannot be taken off by a search that hides the chip it was on.
  const mentionable = useMemo(() => {
    const wanted = mentionQuery.trim().toLowerCase()
    const matches = wanted
      ? staff.filter((person) => person.name.toLowerCase().includes(wanted))
      : staff
    const shown = matches.slice(0, MENTION_CHIPS)
    const picked = staff.filter(
      (person) => mentions.includes(person.id) && !shown.some((one) => one.id === person.id),
    )
    return { shown: [...picked, ...shown], hidden: Math.max(0, matches.length - shown.length) }
  }, [mentionQuery, mentions, staff])

  return (
    <div className="uin-composer uin-droppable" {...drop.dropProps}>
      <AttachmentDropOverlay dragging={drop.dragging} />
      {/* Above the chips, and shown whenever there is a reason at all. It used
          to be tied to the mode, which meant it appeared only on modes that are
          not offered when it applies - so the one person who needed it, the one
          left with nothing but Internal note, was the one person who never saw
          it. */}
      {cannotReplyReason && (
        <div className="alert alert-info">{cannotReplyReason}</div>
      )}

      <div className="uin-composer-modes" role="group" aria-label="What to send">
        {modes.map((m) => (
          <button
            key={m.id}
            type="button"
            className="uin-chip"
            aria-pressed={mode === m.id}
            onClick={() => { setMode(m.id); setError(''); setNote('') }}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === 'forward' ? (
        <div className="field">
          <label htmlFor="uin-forward-to">Forward to</label>
          <input
            id="uin-forward-to"
            type="text"
            value={forwardTo}
            onChange={(e) => { setForwardTo(e.target.value); setDirty(true) }}
            placeholder="name@example.com"
            autoComplete="off"
          />
        </div>
      ) : mode === 'note' ? (
        <p className="uin-recipients">
          Only your colleagues see this. Nothing is sent to the customer.
        </p>
      ) : (
        <p className="uin-recipients">
          {recipients.length > 0 ? `To ${recipients.join(', ')}` : 'There is nobody to reply to on this conversation.'}
        </p>
      )}

      <div className="field">
        <label htmlFor="uin-composer-text">
          {mode === 'note' ? 'Your note' : 'Your message'}
        </label>
        <textarea
          id="uin-composer-text"
          value={text}
          onChange={(e) => { setText(e.target.value); setDirty(true); setNote('') }}
          placeholder={mode === 'note' ? 'Something for the others to see' : 'Write your reply'}
        />
      </div>

      {mode === 'note' && staff.length > 0 && (
        <div className="uin-actions">
          {staff.length > MENTION_CHIPS && (
            <div className="field">
              <label htmlFor="uin-mention-search">Let somebody know</label>
              <input
                id="uin-mention-search"
                type="search"
                value={mentionQuery}
                placeholder="Start typing a name"
                autoComplete="off"
                onChange={(e) => setMentionQuery(e.target.value)}
              />
            </div>
          )}
          <div className="uin-composer-row">
            {staff.length <= MENTION_CHIPS && <span className="uin-recipients">Let somebody know</span>}
            {mentionable.shown.map((person) => (
              <button
                key={person.id}
                type="button"
                className="uin-chip"
                aria-pressed={mentions.includes(person.id)}
                onClick={() => setMentions((prev) =>
                  prev.includes(person.id) ? prev.filter((id) => id !== person.id) : [...prev, person.id],
                )}
              >
                {person.name}
              </button>
            ))}
            {mentionable.shown.length === 0 && (
              <span className="uin-recipients">Nobody here goes by that.</span>
            )}
            {mentionable.hidden > 0 && (
              <span className="uin-recipients">
                {mentionable.hidden === 1
                  ? 'One more. Keep typing to find them.'
                  : `${mentionable.hidden} more. Keep typing to find them.`}
              </span>
            )}
          </div>
        </div>
      )}

      {mode !== 'note' && (
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
          <span className="uin-recipients">or drag one onto this box</span>
        </div>
      )}

      {mode !== 'note' && (
        <AttachmentDropNotice
          progress={drop.progress}
          errors={drop.errors}
          dismissErrors={drop.dismissErrors}
        />
      )}

      {/* An internal note is not sent to anybody, so there is nothing to send
          later. Neither is a reply with nobody to reply to. */}
      {mode !== 'note' && (
        <SendLater
          sendAt={sendAt}
          sendState={sendState}
          sendError={sendError}
          followUpMinutes={followUpMinutes}
          held={held}
          minWallClock={minSendAt}
          timezone={timezone}
          busy={busy}
          disabled={nobodyToReplyTo}
          onSchedule={(wallClock, followUp) => { void save(wallClock, followUp) }}
          onCancel={() => { void save(null) }}
        />
      )}

      {error && <div className="alert alert-danger" role="alert">{error}</div>}
      {note && !error && <div className="alert alert-success" role="status">{note}</div>}

      <div className="uin-composer-row">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={submit}
          // Nothing to reply to means the server would refuse it anyway, and
          // finding that out by pressing Send is finding it out too late.
          disabled={busy || nobodyToReplyTo}
        >
          {busyWith === 'send'
            ? (mode === 'note' ? 'Saving...' : 'Sending...')
            : mode === 'note' ? 'Save note' : 'Send'}
        </button>
        {mode !== 'note' && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => { void save() }}
            disabled={busy}
          >
            {busyWith === 'save' ? 'Saving...' : 'Save as a draft'}
          </button>
        )}
        {mode !== 'note' && draftId && (
          <button type="button" className="uin-chip" onClick={() => setAsking(true)} disabled={busy}>
            {busyWith === 'discard' ? 'Throwing it away...' : 'Throw the draft away'}
          </button>
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

      <ConfirmDialog
        open={leavingTo !== null}
        title="Leave this reply?"
        body="What you have written is not saved anywhere yet, and moving on loses it. Save it as a draft first if you want it back."
        confirmLabel="Leave it"
        cancelLabel="Keep writing"
        destructive
        onCancel={() => setLeavingTo(null)}
        onConfirm={() => {
          const going = leavingTo
          setLeavingTo(null)
          if (going) router.push(going)
        }}
      />

      <ConfirmDialog
        open={asking}
        title="Throw this draft away?"
        body="What you have written goes with it, and there is no getting it back."
        confirmLabel="Throw it away"
        destructive
        busy={busyWith === 'discard'}
        // Held open while the request is in flight, so the answer and the
        // waiting are in the same place, and shut once it has come back.
        onCancel={() => { if (busyWith !== 'discard') setAsking(false) }}
        onConfirm={() => { void discard().then(() => setAsking(false)) }}
      />
    </div>
  )
}
