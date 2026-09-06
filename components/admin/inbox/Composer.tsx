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
import { ProductChips, ProductPicker, productKey } from './ProductPicker'
import { AttachmentDropNotice, AttachmentDropOverlay } from './AttachmentDropChrome'
import { useAttachmentDrop } from './useAttachmentDrop'
import { ConfirmDialog } from './ConfirmDialog'
import { Dropdown } from './Dropdown'
import { PendingSend } from './PendingSend'
import { RecipientField } from './RecipientField'
import { RichText, RichTextBox, RichTextTools } from './RichText'
import { ScheduleNotice } from './ScheduleNotice'
import { SendLaterPanel } from './SendLaterPanel'
import { SnoozePanel } from './SnoozePanel'
import { CloseIcon, CollapseIcon, ExpandIcon, PaperclipIcon, TagIcon } from './icons'
import { useComposerOpen } from './composer-open'
import type { DraftSendState } from '@/modules/unified-inbox/lib/types'
import type { ProductChoice } from '@/modules/unified-inbox/lib/products/types'

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
  /** Whether this person can put anything out of the catalogue on a message:
   *  the site sells something, and they are allowed to see what. */
  canAddProducts: boolean
  /** The products the draft was carrying, already looked up. The draft itself
   *  remembers only which - the names and the prices are today's. */
  draftProducts: ProductChoice[]
  /** Which of the three the button at the top of the conversation asked for.
   *  The chips below still change it afterwards - this only says what it opened
   *  as, and what a later press up there changed it to. */
  requestedMode?: Mode
  /** Counts those presses, so pressing Forward twice still reads as a second
   *  instruction rather than as nothing having changed. */
  requestedAt?: number
  timezone: string
}

/** What the box calls itself, in the strip along its top. It used to be a row
 *  of four chips that also SWITCHED between them, which was a second door to a
 *  choice already made on the message being answered - and the commonest way to
 *  turn a reply into a forward by accident. The choice lives on the message
 *  now; this only says which one you are writing. */
const MODE_WORDS: Record<Mode, string> = {
  reply: 'Reply',
  'reply-all': 'Reply to all',
  forward: 'Forward',
  note: 'Internal note',
}

export function Composer({
  threadId, inboxId, replyTo, replyAllTo, canReply, canForward, staff,
  cannotReplyReason, replySubject, forwardSubject, draft, canAddProducts, draftProducts,
  requestedMode, requestedAt, timezone,
}: Props) {
  const router = useRouter()
  const { close: closeComposer } = useComposerOpen()
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
  // What the reply carries out of the catalogue. Whole products here so the
  // chips can say what they are; only the references are ever sent, and what
  // the customer reads is built on the server when Send is pressed.
  const [products, setProducts] = useState<ProductChoice[]>(draftProducts)
  const [pickingProduct, setPickingProduct] = useState(false)
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
    if (requestedMode) {
      setMode(requestedMode)
      setError('')
      setNote('')
      // Switching between a reply and a reply to everybody refills the To box,
      // because that is the whole of what the difference means - unless
      // somebody has already edited it, in which case their answer stands.
      if (!recipientsEdited && requestedMode !== 'forward' && requestedMode !== 'note') {
        setReplyRecipients(defaultRecipients(requestedMode))
      }
    }
  }

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

  const hasUnsaved = dirty && (
    htmlHasWriting(text)
    || recipientsEdited
    || forwardTo.trim().length > 0
    || cc.trim().length > 0
    || bcc.trim().length > 0
    || subject.trim().length > 0
    || attachments.length > 0
    || products.length > 0
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
            products: products.map(({ moduleName, kind, id }) => ({ moduleName, kind, id })),
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
      // The catalogue clears with the files, for the same reason: the box is
      // empty and ready for the next reply, and chips left over from a message
      // that has already gone are three chairs somebody sends twice.
      setProducts([])
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
    attachments, bcc, cc, defaultRecipients, draftId, mentions, mode, products, recipients, router,
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
      // A note is a message to colleagues on this site's own screen, and a
      // catalogue table is for somebody outside it. Anything picked before the
      // box was switched to a note stays picked and simply does not travel.
      products: mode === 'note'
        ? []
        : products.map(({ moduleName, kind, id }) => ({ moduleName, kind, id })),
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
  }, [attachments, bcc, cc, draftId, mode, products, recipients, router, subject, text, threadId])

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

  /** Whether the cross in the corner is asking about the writing before it
   *  shuts the box. */
  const [closing, setClosing] = useState(false)

  /** The cross in the corner of the box, and the one on the popped-out window.
   *  With nothing typed since the last time it was put down it simply shuts;
   *  with something to lose it asks the one question worth asking - keep it,
   *  throw it away, or carry on writing - rather than the old question, which
   *  offered "Leave it" and quietly meant "lose it". */
  const askToClose = useCallback(() => {
    if (hasUnsaved) setClosing(true)
    else closeComposer()
  }, [closeComposer, hasUnsaved])

  /** Stops the save below being started twice while it is in flight - the
   *  effect it lives in re-runs whenever anything typed changes. */
  const leaving = useRef(false)

  // A click on a link that would take the screen somewhere else was caught by
  // the listener above. It used to raise a dialog asking whether to lose the
  // reply; now the reply is simply put down as a draft and the click carries
  // on, which is what every mail program does and what nobody has ever had to
  // be asked about. Only a save that actually FAILED stops the journey - the
  // error is on the screen and the writing is still in the box.
  //
  // A note is the exception, and gets the question instead: notes are not saved
  // as drafts - a draft is a message on its way out - so there is nothing to
  // put it down as, and walking off with it silently would lose it.
  useEffect(() => {
    if (noting) return
    if (!leavingTo || leaving.current) return
    leaving.current = true
    void save().then((ok) => {
      leaving.current = false
      const going = leavingTo
      setLeavingTo(null)
      if (ok && going) router.push(going)
    })
  }, [leavingTo, noting, router, save])

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
    // The provider rather than a box: the words are drawn in the middle of this
    // and the buttons that format them are drawn on the strip along the bottom,
    // and both of them have to be talking about the same box.
    <RichText
      id="uin-composer-text"
      value={text}
      onChange={(html) => { setText(html); setDirty(true); setNote('') }}
      placeholder={noting ? 'Something for the others to see' : 'Write your reply'}
      label={noting ? 'Your note' : 'Your message'}
    >
    <div className="uin-composer uin-droppable" {...drop.dropProps}>
      <AttachmentDropOverlay dragging={drop.dragging} />
      {/* First in the box, and shown whenever there is a reason at all. It used
          to be tied to the mode, which meant it appeared only on modes that are
          not offered when it applies - so the one person who needed it, the one
          left with nothing but Internal note, was the one person who never saw
          it. */}
      {cannotReplyReason && (
        <div className="alert alert-info">{cannotReplyReason}</div>
      )}

      {/* What this is, and the two ways out of it. The row of chips that used to
          sit here switched between reply, reply to all, forward and note - a
          second place to make a choice already made on the message being
          answered, and the commonest way to send a customer a forward meant for
          a colleague. Which one it is still has to be SAID, though, so it is
          said in words. */}
      <div className="uin-composer-head">
        <span className="uin-composer-title">{MODE_WORDS[mode]}</span>
        <span className="uin-composer-head-tools">
          <button
            type="button"
            className="uin-icon-btn"
            aria-label={poppedOut ? 'Put it back under the conversation' : 'Open it in a window of its own'}
            title={poppedOut ? 'Put it back' : 'Open it in a window of its own'}
            onClick={() => setPoppedOut((was) => !was)}
          >
            {poppedOut ? CollapseIcon : ExpandIcon}
          </button>
          <button
            type="button"
            className="uin-icon-btn"
            aria-label="Close this reply"
            title="Close this reply"
            onClick={askToClose}
            disabled={busy}
          >
            {CloseIcon}
          </button>
        </span>
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
              {/* The three lines nobody usually wants. One press each, and none
                  of them takes up a line until it is asked for. */}
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
        <RichTextBox />
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
          the place every mail program has kept it. What you do TO the message
          is on the left: the files, the catalogue, when it leaves, and the six
          formatting buttons, which used to sit in a strip of their own above the
          words and are the same six wherever they are drawn. The ways it leaves
          are on the right, and the gap between the two groups is deliberate.

          When the column is too narrow for one line, the two send buttons wrap
          as a pair and stay hard right - and if only one of them fits, it is
          Send now that keeps the first line, because that is the one somebody
          came to press. See uin-send-group in styles.tsx for how. */}
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
            {canAddProducts && (
              <button
                type="button"
                className="uin-icon-btn"
                title="Put something you sell on this message"
                aria-label="Put something you sell on this message"
                onClick={() => setPickingProduct(true)}
                disabled={busy}
              >
                {TagIcon}
              </button>
            )}
          </>
        )}

        <RichTextTools />

        {/* Words in a box rather than a bell nobody could read. It was an alarm
            clock icon beside the paperclip, which is a picture of a thing
            rather than the name of one - and the one control on the strip that
            people asked what it did. The same menu also
            stands a time back down again, which is why it is still here on a
            message that is already waiting for one. */}
        {!noting && (
          <Dropdown
            className="btn btn-secondary btn-sm"
            label={'Send Later'}
            title={waiting ? 'Change when this goes out' : 'Choose when this goes out'}
            width={280}
            panelClassName="uin-menu-snooze"
            disabled={busy || (!waiting && nobodyToSendTo)}
          >
            <SendLaterPanel
              timezone={timezone}
              busy={busy}
              scheduled={waiting}
              onPick={(at) => { setPendingSendAt(at); setError('') }}
              onCancelTimer={() => { setPendingSendAt(null); void save(null) }}
            />
          </Dropdown>
        )}

        {!noting && (
          <>
            <AttachmentChips
              attachments={attachments}
              disabled={busy}
              onRemove={(key) => {
                setAttachments((prev) => prev.filter((p) => p.key !== key))
                setDirty(true)
              }}
            />
            <ProductChips
              products={products}
              disabled={busy}
              onRemove={(key) => {
                setProducts((prev) => prev.filter((p) => productKey(p) !== key))
                setDirty(true)
              }}
            />
          </>
        )}

        <span className="uin-composer-gap" />

        {/* A reply with a time on it has already been decided about. Sending it
            now would contradict that decision, so while it waits the notice
            above is the whole of what is left to do: move it, or cancel the
            timer and have the buttons back. */}
        {!noting && draftId && (
          <button type="button" className="uin-chip" onClick={() => setAsking(true)} disabled={busy}>
            {busyWith === 'discard' ? 'Throwing it away...' : 'Throw the draft away'}
          </button>
        )}

        <span className="uin-send-group">
          {/* Committing the time that was picked off the menu. It does not say
              "Send later" as well: two buttons a thumb apart with the same words
              on them is one of them pressed by mistake. */}
          {!noting && !waiting && pendingWallClock && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => { void save(pendingWallClock, pendingFollowUp) }}
              disabled={busy || nobodyToSendTo}
            >
              {busyWith === 'save' ? 'Saving...' : 'Save it for then'}
            </button>
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
        </span>
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

      {/* Left open after a pick, unlike the file list: quoting somebody three
          chairs is one errand, not three trips into the catalogue. */}
      {pickingProduct && (
        <ProductPicker
          chosen={products}
          onClose={() => setPickingProduct(false)}
          onPick={(item) => {
            setProducts((prev) =>
              prev.some((p) => productKey(p) === productKey(item)) ? prev : [...prev, item],
            )
            setDirty(true)
          }}
        />
      )}
    </div>
    </RichText>
  )

  const dialogs = (
    <>
      {/* Three answers, because the question genuinely has three. It used to
          have two - "Leave it" and "Keep writing" - and the first of them threw
          away whatever was in the box while saying nothing about it.

          A note is the exception, and has two: notes are not saved as drafts at
          all - a draft is a message on its way out, and a note is not one - so
          offering to keep one would quietly turn it into a reply nobody wrote. */}
      {noting ? (
        <ConfirmDialog
          open={closing}
          title="Throw this note away?"
          body="It has not been left on the conversation, and closing loses it."
          confirmLabel="Throw it away"
          cancelLabel="Keep writing"
          destructive
          onCancel={() => setClosing(false)}
          onConfirm={() => { setClosing(false); closeComposer() }}
        />
      ) : (
        <ConfirmDialog
          open={closing}
          title="Keep this as a draft?"
          body="Nothing here has been sent. It can wait under Drafts, and here, until you come back to it."
          confirmLabel="Save it as a draft"
          cancelLabel="Keep writing"
          busy={busy}
          other={{
            label: 'Throw it away',
            destructive: true,
            onClick: () => {
              setClosing(false)
              // A draft that was saved earlier goes with it; one that was never
              // saved has nothing to delete, and the box simply shuts.
              if (draftId) void discard().then(() => closeComposer())
              else closeComposer()
            },
          }}
          onCancel={() => { if (!busy) setClosing(false) }}
          onConfirm={() => {
            void save().then((ok) => {
              if (!ok) return
              setClosing(false)
              closeComposer()
            })
          }}
        />
      )}

      {/* Only ever raised on a note, for the reason above: everything else is
          already saved by the time the screen moves. */}
      <ConfirmDialog
        open={noting && leavingTo !== null}
        title="Leave this note?"
        body="It has not been left on the conversation, and moving on loses it."
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
          {/* Two different things, and they were one: putting the window back
              under the conversation is not closing the reply, and a single
              button cannot mean both. */}
          <span className="uin-modal-head-tools">
            <button
              type="button"
              className="uin-modal-close"
              aria-label="Put it back under the conversation"
              title="Put it back"
              onClick={() => setPoppedOut(false)}
            >
              {CollapseIcon}
            </button>
            <button
              type="button"
              className="uin-modal-close"
              aria-label="Close this reply"
              title="Close this reply"
              onClick={askToClose}
              disabled={busy}
            >
              {CloseIcon}
            </button>
          </span>
        </div>
        <div className="uin-modal-body">{body}</div>
      </div>
      {dialogs}
    </div>,
    document.body,
  )
}
