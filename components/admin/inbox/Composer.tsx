'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import {
  htmlHasWriting,
  isWorthSaving,
  splitAddresses,
  type DraftForComposer,
} from '@/modules/unified-inbox/lib/drafts'
import { plainTextToHtml, toWallClock } from '@/modules/unified-inbox/lib/scheduled'
import { AttachmentChips, AttachmentPicker, plainReason, type Attachment } from './AttachmentPicker'
import { AttachmentDropNotice, AttachmentDropOverlay } from './AttachmentDropChrome'
import { useAttachmentDrop } from './useAttachmentDrop'
import { ConfirmDialog } from './ConfirmDialog'
import { Dropdown } from './Dropdown'
import { PendingSend } from './PendingSend'
import { RecipientField } from './RecipientField'
import { RichText } from './RichText'
import { ScheduleNotice } from './ScheduleNotice'
import { SendLaterPanel } from './SendLaterPanel'
import { SnoozePanel } from './SnoozePanel'
import { AlarmIcon, CollapseIcon, ExpandIcon, PaperclipIcon } from './icons'
import type { DraftSendState } from '@/modules/unified-inbox/lib/types'

// The composer: reply, reply to everybody, forward, and an internal note.
//
// Almost nothing about a message is decided here. The signature, the quoted
// original, the Message-ID and the References chain all live in the module's
// own pure code on the server, where they are tested - this is a box to type in
// and a button to press. Sending the same thing twice is the one thing the
// browser has to help with, and it does it by carrying a token.
//
// Who it goes to IS decided here now, which it was not before. The server still
// works out who a plain reply would go to and that is still what the box opens
// on - but it opens in a box rather than in a sentence, so the one address that
// wants taking off, or the colleague who wants adding, is a click rather than a
// forward. Cc, Bcc and the subject are one link each above the writing, closed
// until somebody wants them: a reply that needs none of the three - which is
// nearly every reply - should not have to look at three empty lines to find
// that out.
//
// The pop-out puts the same box in front of everything else, for the reply that
// turns out to be a letter. It is the SAME composer either way - the state is
// held here and only the frame around it moves - so nothing is lost by popping
// out halfway through a sentence.

export type ComposerMode = 'reply' | 'reply-all' | 'forward' | 'note'
type Mode = ComposerMode

type StaffMember = { id: string; name: string }

/** How many colleagues are offered as chips before the list gets a box to
 *  narrow it with. Twenty names wrapped across the composer is a wall, not a
 *  menu. */
const MENTION_CHIPS = 8

type Props = {
  threadId: string
  /** Which address it leaves as, so the suggestions under To are the people
   *  this address deals with rather than the whole site's. Null on a
   *  conversation another module owns, which has no sending address. */
  inboxId: string | null
  /** Who a plain reply would go to, worked out on the server. What the To box
   *  opens on, rather than what it is stuck with. */
  replyTo: string[]
  replyAllTo: string[]
  canReply: boolean
  canForward: boolean
  staff: StaffMember[]
  /** Left over when the inbox this conversation belongs to cannot send - no
   *  sending identity, or the person may read it but not answer it. */
  cannotReplyReason: string | null
  /** What the subject line would say if nobody touched it, worked out on the
   *  server the same way the send route works it out. Only ever seen once
   *  somebody opens the Subject line to change it. */
  replySubject: string
  forwardSubject: string
  /** What this person left in this box last time, if they left anything. */
  draft: DraftForComposer | null
  /** Which of the three the button at the top of the conversation asked for.
   *  The chips below still change it afterwards - this only says what it opened
   *  as, and what a later press up there changed it to. */
  requestedMode?: Mode
  /** Counts those presses, so pressing Forward twice still reads as a second
   *  instruction rather than as nothing having changed. */
  requestedAt?: number
  timezone: string
}

export function Composer({
  threadId, inboxId, replyTo, replyAllTo, canReply, canForward, staff,
  cannotReplyReason, replySubject, forwardSubject, draft, requestedMode, requestedAt, timezone,
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
  // The markup in the writing box. A draft written before the box could hold
  // any is turned into markup on the way in, so its line breaks survive - and
  // is saved back as markup the first time anybody touches it.
  const [text, setText] = useState(
    draft ? (draft.bodyFormat === 'html' ? draft.body : plainTextToHtml(draft.body)) : '',
  )

  /** Who a reply of this kind would go to, as one line of text. */
  const defaultRecipients = useCallback(
    (which: Mode) => (which === 'reply-all' ? replyAllTo : replyTo).join(', '),
    [replyAllTo, replyTo],
  )

  // Two boxes rather than one, because they answer different questions. A reply
  // is addressed to whoever wrote, a forward to somebody who has not seen it at
  // all, and switching between the two must not hand a forward the customer's
  // address by default. Within reply and reply-all the box refills itself as
  // the chips are pressed - until somebody edits it, at which point their
  // answer beats ours.
  const [replyRecipients, setReplyRecipients] = useState(() => {
    const saved = draft && draft.mode !== 'forward' ? draft.to : []
    if (saved.length > 0) return saved.join(', ')
    return defaultRecipients(mode)
  })
  const [recipientsEdited, setRecipientsEdited] = useState(
    () => !!draft && draft.mode !== 'forward' && draft.to.length > 0,
  )
  const [forwardTo, setForwardTo] = useState(
    () => (draft?.mode === 'forward' ? draft.to : []).join(', '),
  )
  const [cc, setCc] = useState((draft?.cc ?? []).join(', '))
  const [bcc, setBcc] = useState((draft?.bcc ?? []).join(', '))
  const [subject, setSubject] = useState(draft?.subject ?? '')
  // Each of the three lines is closed until somebody wants it - and open from
  // the start on a draft that already has something on it, because a saved Bcc
  // that nobody could see would be the worst of both worlds.
  const [showCc, setShowCc] = useState((draft?.cc ?? []).length > 0)
  const [showBcc, setShowBcc] = useState((draft?.bcc ?? []).length > 0)
  const [showSubject, setShowSubject] = useState(!!draft?.subject?.trim())
  /** Whether the box is drawn over the whole screen rather than under the
   *  conversation. State, not a route: the reply is half written, and a
   *  navigation would take it off the page. */
  const [poppedOut, setPoppedOut] = useState(false)

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
  // A time somebody has picked off the alarm clock and not yet committed. It is
  // deliberately not saved on the spot: "send it later" and "send it later and
  // put this conversation to sleep until then" are two instructions, and the
  // menu cannot know which one is coming.
  const [pendingSendAt, setPendingSendAt] = useState<Date | null>(null)
  const [pendingFollowUp, setPendingFollowUp] = useState<number | null>(draft?.followUpMinutes ?? null)
  // Waiting for its own time, or going out this minute. Either way it is out of
  // this composer's hands.
  const waiting = sendState === 'scheduled' || sendState === 'sending'
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

  /** Switching between a reply and a reply to everybody refills the To box,
   *  because that is the whole of what the two chips mean - unless somebody has
   *  already edited it, in which case their answer stands and the chip only
   *  changes what the server quotes. */
  const changeMode = useCallback((next: Mode) => {
    setMode(next)
    setError('')
    setNote('')
    if (!recipientsEdited && next !== 'forward' && next !== 'note') {
      setReplyRecipients(defaultRecipients(next))
    }
  }, [defaultRecipients, recipientsEdited])

  const forwarding = mode === 'forward'
  const noting = mode === 'note'
  /** The line the message is actually addressed by, whichever box it came out
   *  of. */
  const recipients = forwarding ? forwardTo : replyRecipients
  const setRecipients = forwarding
    ? (value: string) => { setForwardTo(value); setDirty(true) }
    : (value: string) => { setReplyRecipients(value); setRecipientsEdited(true); setDirty(true) }
  const nobodyToSendTo = !noting && splitAddresses(recipients).length === 0

  /** What the subject would be if nobody touched it. Only ever shown once the
   *  Subject line has been opened - a reply with a subject nobody typed is what
   *  every reply has always been. */
  const defaultSubject = forwarding ? forwardSubject : replySubject

  /** A file dragged straight onto the box, rather than found in the library.
   *  Off for an internal note, which is not sent anywhere and has nothing to
   *  carry a file on, and off while something is in flight for the reason the
   *  chips are greyed then: a message on its way is not one to add to. */
  const drop = useAttachmentDrop({
    disabled: busy || noting,
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

  const hasUnsaved = dirty && (
    htmlHasWriting(text)
    || recipientsEdited
    || forwardTo.trim().length > 0
    || cc.trim().length > 0
    || bcc.trim().length > 0
    || subject.trim().length > 0
    || attachments.length > 0
  )

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

  // Popped out, the box is a dialog and behaves like one: the page behind it
  // does not scroll under it, and Escape puts it back. Nothing is lost either
  // way - collapsing is not closing, and what is typed is held here rather than
  // in the frame around it.
  useEffect(() => {
    if (!poppedOut) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setPoppedOut(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previous
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [poppedOut])

  /** Puts the conversation to sleep. Its own small request rather than part of
   *  the send: the message going out and the conversation going quiet are two
   *  separate facts, and a failure to do the second must not be reported as a
   *  failure to do the first. */
  const snoozeThread = useCallback(async (until: Date) => {
    try {
      const response = await fetch(`/api/m/unified-inbox/threads/${threadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'snoozed', snoozeUntil: until.toISOString() }),
      })
      if (!response.ok) {
        setError(plainReason(
          (await response.json().catch(() => null))?.error,
          'That went, but the conversation could not be put to sleep.',
        ))
        return
      }
      router.refresh()
    } catch {
      setError('That went, but the site could not be reached to put the conversation to sleep.')
    }
  }, [router, threadId])

  const submit = useCallback(async (): Promise<boolean> => {
    if (!htmlHasWriting(text)) {
      setError('There is nothing to send yet.')
      return false
    }
    const to = splitAddresses(recipients)
    if (mode !== 'note' && to.length === 0) {
      setError(mode === 'forward' ? 'Say who to forward it to.' : 'Say who this is going to.')
      return false
    }
    if (inFlight.current) return false
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
          return false
        }
      } else {
        const response = await fetch('/api/m/unified-inbox/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            threadId,
            mode,
            to,
            cc: splitAddresses(cc),
            bcc: splitAddresses(bcc),
            // Left out is "whatever the server would have called it", which is
            // what every reply nobody touched the subject on wants.
            subject: subject.trim() || undefined,
            // Already markup. It is sanitised on the server, at the last gate
            // before it leaves, exactly as a pasted signature is.
            bodyHtml: text,
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
          return false
        }
      }
      setText('')
      setForwardTo('')
      setCc('')
      setBcc('')
      setSubject('')
      setShowCc(false)
      setShowBcc(false)
      setShowSubject(false)
      setReplyRecipients(defaultRecipients(mode))
      setRecipientsEdited(false)
      setAttachments([])
      setMentions([])
      setMentionQuery('')
      setDirty(false)
      // The draft went with the message, and so did any time on it.
      setSendAt(null)
      setSendState(null)
      setSendError(null)
      setPendingSendAt(null)
      // Said out loud, because the box emptying could as easily mean something
      // went wrong as mean it went.
      setNote(mode === 'note' ? 'Your note is on the conversation.' : 'Sent. It is on the conversation above.')
      // The message has gone, so the draft behind it went with it - server
      // side, in the send route, rather than as a second request from here
      // that a closed tab could swallow.
      setDraftId(null)
      token.current = crypto.randomUUID()
      router.refresh()
      return true
    } catch {
      setError('The site could not be reached. Nothing was sent.')
      return false
    } finally {
      inFlight.current = false
      setBusyWith(null)
    }
  }, [
    attachments, bcc, cc, defaultRecipients, draftId, mentions, mode, recipients, router,
    subject, text, threadId,
  ])

  /** Puts the box down as a draft, with or without a time on it. Saving and
   *  scheduling are one request on purpose: a scheduled message IS a draft with
   *  a departure time, and two requests would leave a window where the writing
   *  was saved and the time was not. `wallClock` null takes a time back off. */
  const save = useCallback(async (
    wallClock?: string | null,
    followUp?: number | null,
  ): Promise<boolean> => {
    const payload = {
      id: draftId ?? undefined,
      threadId,
      mode: mode === 'note' ? ('reply' as const) : mode,
      to: mode === 'note' ? [] : splitAddresses(recipients),
      cc: splitAddresses(cc),
      bcc: splitAddresses(bcc),
      subject: subject.trim() || null,
      body: text,
      bodyFormat: 'html' as const,
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
      return false
    }
    if (inFlight.current) return false
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
        return false
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
      // The time that was pending is on the row now, so it is no longer
      // something waiting to be committed.
      if (wallClock !== undefined) setPendingSendAt(null)
      setDirty(false)
      setNote(at
        ? 'Saved, and set to go out on its own.'
        : 'Saved. It is waiting under Drafts, and here.')
      router.refresh()
      return true
    } catch {
      setError('The site could not be reached. Nothing was saved.')
      return false
    } finally {
      inFlight.current = false
      setBusyWith(null)
    }
  }, [attachments, bcc, cc, draftId, mode, recipients, router, subject, text, threadId])

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
      setCc('')
      setBcc('')
      setSubject('')
      setAttachments([])
      setSendAt(null)
      setSendState(null)
      setSendError(null)
      setPendingSendAt(null)
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

  /** The chosen departure time in the shape the server reads it in: a wall
   *  clock with no zone on it, meant in the SITE's zone. */
  const pendingWallClock = pendingSendAt ? toWallClock(pendingSendAt, timezone) : null

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

  /** Return in one of the short lines at the top moves on to the next one,
   *  which is what every mail program does and what fingers expect. It never
   *  sends: Send is a button, and a message posted by a stray Return in the To
   *  box is not a message anybody meant to send. */
  const onLineEnter = (nextId: string) => (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    document.getElementById(nextId)?.focus()
  }

  const body = (
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
            onClick={() => changeMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {noting ? (
        <p className="uin-recipients uin-composer-aside">
          Only your colleagues see this. Nothing is sent to the customer.
        </p>
      ) : (
        <div className="uin-fields">
          <div className="uin-field-row">
            <label htmlFor="uin-reply-to">To</label>
            <div className="uin-field-control">
              <RecipientField
                id="uin-reply-to"
                value={recipients}
                onChange={setRecipients}
                inboxId={inboxId}
                onEnter={onLineEnter(showCc ? 'uin-reply-cc' : showBcc ? 'uin-reply-bcc' : showSubject ? 'uin-reply-subject' : 'uin-composer-text')}
                placeholder="name@example.com"
              />
              {/* The three lines nobody usually wants, and the way to make the
                  box bigger. All four are one press each, and none of them is
                  taking up a line until it is asked for. */}
              <div className="uin-field-links">
                {!showCc && (
                  <button type="button" className="uin-field-add" onClick={() => setShowCc(true)}>Cc</button>
                )}
                {!showBcc && (
                  <button type="button" className="uin-field-add" onClick={() => setShowBcc(true)}>Bcc</button>
                )}
                {!showSubject && (
                  <button
                    type="button"
                    className="uin-field-add"
                    onClick={() => {
                      setShowSubject(true)
                      // Opened to be changed, so it opens on what it would have
                      // said - an empty subject box on a reply is a trap.
                      setSubject((was) => was || defaultSubject)
                    }}
                  >
                    Subject
                  </button>
                )}
                <button
                  type="button"
                  className="uin-icon-btn uin-field-pop"
                  aria-label={poppedOut ? 'Put it back under the conversation' : 'Open it in a window of its own'}
                  title={poppedOut ? 'Put it back' : 'Open it in a window of its own'}
                  onClick={() => setPoppedOut((was) => !was)}
                >
                  {poppedOut ? CollapseIcon : ExpandIcon}
                </button>
              </div>
            </div>
          </div>

          {showCc && (
            <div className="uin-field-row">
              <label htmlFor="uin-reply-cc">Cc</label>
              <div className="uin-field-control">
                <RecipientField
                  id="uin-reply-cc"
                  value={cc}
                  onChange={(next) => { setCc(next); setDirty(true) }}
                  inboxId={inboxId}
                  onEnter={onLineEnter(showBcc ? 'uin-reply-bcc' : showSubject ? 'uin-reply-subject' : 'uin-composer-text')}
                  placeholder="somebody.else@example.com"
                />
                {/* Only while it is empty: a line with an address on it is taken
                    away by clearing it, and a button that quietly dropped
                    somebody off the message would be worse. */}
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

          {showBcc && (
            <div className="uin-field-row">
              <label htmlFor="uin-reply-bcc">Bcc</label>
              <div className="uin-field-control">
                <RecipientField
                  id="uin-reply-bcc"
                  value={bcc}
                  onChange={(next) => { setBcc(next); setDirty(true) }}
                  inboxId={inboxId}
                  onEnter={onLineEnter(showSubject ? 'uin-reply-subject' : 'uin-composer-text')}
                  placeholder="somebody.quiet@example.com"
                />
                {!bcc.trim() && (
                  <button
                    type="button"
                    className="uin-field-add"
                    onClick={() => setShowBcc(false)}
                    aria-label="Take the Bcc line off"
                  >
                    Remove
                  </button>
                )}
                {bcc.trim() && (
                  <span className="uin-field-hint">Nobody else on the message sees these.</span>
                )}
              </div>
            </div>
          )}

          {showSubject && (
            <div className="uin-field-row">
              <label htmlFor="uin-reply-subject">Subject</label>
              <div className="uin-field-control">
                <input
                  id="uin-reply-subject"
                  type="text"
                  value={subject}
                  onChange={(e) => { setSubject(e.target.value); setDirty(true) }}
                  onKeyDown={onLineEnter('uin-composer-text')}
                  placeholder={defaultSubject}
                  autoComplete="off"
                />
                {!subject.trim() && (
                  <button
                    type="button"
                    className="uin-field-add"
                    onClick={() => setShowSubject(false)}
                    aria-label="Take the Subject line off"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="uin-compose-message">
        <RichText
          id="uin-composer-text"
          aria-label={noting ? 'Your note' : 'Your message'}
          value={text}
          onChange={(html) => { setText(html); setDirty(true); setNote('') }}
          placeholder={noting ? 'Something for the others to see' : 'Write your reply'}
        />
      </div>

      {noting && staff.length > 0 && (
        <div className="uin-composer-row">
          {staff.length > MENTION_CHIPS ? (
            <div className="uin-mention-search">
              <label className="sr-only" htmlFor="uin-mention-search">Let somebody know</label>
              <input
                id="uin-mention-search"
                type="search"
                value={mentionQuery}
                placeholder="Let somebody know - start typing a name"
                autoComplete="off"
                onChange={(e) => setMentionQuery(e.target.value)}
              />
            </div>
          ) : (
            <span className="uin-recipients">Let somebody know</span>
          )}
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
      )}

      {!noting && (
        <AttachmentDropNotice
          progress={drop.progress}
          errors={drop.errors}
          dismissErrors={drop.dismissErrors}
        />
      )}

      {/* An internal note is not sent to anybody, so it has no departure time
          to have anything to say about. */}
      {!noting && (
        <ScheduleNotice
          sendAt={sendAt}
          sendState={sendState}
          sendError={sendError}
          followUpMinutes={followUpMinutes}
          held={held}
          timezone={timezone}
        />
      )}

      {!noting && pendingSendAt && !waiting && (
        <PendingSend
          at={pendingSendAt}
          followUp={pendingFollowUp}
          onFollowUp={(minutes) => { setPendingFollowUp(minutes); setError('') }}
          onProblem={setError}
          onClear={() => setPendingSendAt(null)}
          timezone={timezone}
          busy={busy}
        />
      )}

      {error && <div className="alert alert-danger" role="alert">{error}</div>}
      {note && !error && <div className="alert alert-success" role="status">{note}</div>}

      {/* Everything you can do to the message, on one strip along the bottom -
          the place every mail program has kept it. The two icons on the left are
          things you do TO the message, the buttons on the right are the ways it
          leaves, and the gap between them is deliberate. */}
      <div className="uin-composer-row uin-composer-actions">
        {!noting && (
          <>
            <button
              type="button"
              className="uin-icon-btn"
              title="Attach a file, or drag one onto this box"
              aria-label="Attach a file, or drag one onto this box"
              onClick={() => setPicking(true)}
              disabled={busy}
            >
              {PaperclipIcon}
            </button>
            <Dropdown
              className="uin-icon-btn"
              label={AlarmIcon}
              ariaLabel="Send it later"
              title="Send it later"
              width={280}
              panelClassName="uin-menu-snooze"
              disabled={busy || nobodyToSendTo}
            >
              <SendLaterPanel
                timezone={timezone}
                busy={busy}
                scheduled={waiting}
                onPick={(at) => { setPendingSendAt(at); setError('') }}
                onCancelTimer={() => { setPendingSendAt(null); void save(null) }}
              />
            </Dropdown>
            <AttachmentChips
              attachments={attachments}
              disabled={busy}
              onRemove={(key) => {
                setAttachments((prev) => prev.filter((p) => p.key !== key))
                setDirty(true)
              }}
            />
          </>
        )}

        <span className="uin-composer-gap" />

        {/* A reply with a time on it has already been decided about. Send would
            post it now and Save would look like the way to keep it, which it is
            not - so while it is waiting, the notice above is the whole of what
            is left to do: move it, or cancel the timer and have these back. */}
        {!noting && draftId && (
          <button type="button" className="uin-chip" onClick={() => setAsking(true)} disabled={busy}>
            {busyWith === 'discard' ? 'Throwing it away...' : 'Throw the draft away'}
          </button>
        )}
        {!noting && !waiting && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => { void save() }}
            disabled={busy}
          >
            {busyWith === 'save' ? 'Saving...' : 'Save as a draft'}
          </button>
        )}

        {!noting && !waiting && pendingWallClock && (
          <>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => { void save(pendingWallClock, pendingFollowUp) }}
              disabled={busy || nobodyToSendTo}
            >
              Send later
            </button>
            <Dropdown
              className="btn btn-secondary btn-sm"
              label={'Send later & snooze'}
              align="end"
              width={280}
              panelClassName="uin-menu-snooze"
              disabled={busy || nobodyToSendTo}
            >
              <SnoozePanel
                timezone={timezone}
                busy={busy}
                title="Send it later, then sleep until"
                onSnooze={(until) => {
                  void save(pendingWallClock, pendingFollowUp).then((ok) => {
                    if (ok) void snoozeThread(until)
                  })
                }}
              />
            </Dropdown>
          </>
        )}

        {!noting && !waiting && (
          <Dropdown
            className="btn btn-secondary btn-sm"
            label={'Send & snooze'}
            align="end"
            width={280}
            panelClassName="uin-menu-snooze"
            disabled={busy || nobodyToSendTo}
          >
            <SnoozePanel
              timezone={timezone}
              busy={busy}
              title="Send it, then sleep until"
              onSnooze={(until) => {
                void submit().then((ok) => { if (ok) void snoozeThread(until) })
              }}
            />
          </Dropdown>
        )}

        {!waiting && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => { void submit() }}
            // Nothing to send to means the server would refuse it anyway, and
            // finding that out by pressing Send is finding it out too late.
            disabled={busy || nobodyToSendTo}
          >
            {busyWith === 'send'
              ? (noting ? 'Saving...' : 'Sending...')
              : noting ? 'Save note' : 'Send now'}
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
    </div>
  )

  const dialogs = (
    <>
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
    </>
  )

  if (!poppedOut) {
    return <>{body}{dialogs}</>
  }

  // Drawn into the body rather than where the composer sits, so it is over the
  // conversation rather than inside a pane that scrolls. It is still the same
  // component - only the frame around it moved - so nothing typed is lost by
  // popping out or by putting it back.
  return createPortal(
    <div className="uin-modal">
      <div
        className="uin-modal-card uin-modal-card-compose"
        role="dialog"
        aria-modal="true"
        aria-label="Your reply"
      >
        <div className="uin-modal-head">
          <h2 className="uin-modal-title">Your reply</h2>
          <button
            type="button"
            className="uin-modal-close"
            aria-label="Put it back under the conversation"
            onClick={() => setPoppedOut(false)}
          >
            {CollapseIcon}
          </button>
        </div>
        <div className="uin-modal-body">{body}</div>
      </div>
      {dialogs}
    </div>,
    document.body,
  )
}
