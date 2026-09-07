'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import {
  htmlHasWriting,
  isWorthSaving,
  splitAddresses,
  NEEDS_A_RECIPIENT,
  NEEDS_SOMEBODY_TO_FORWARD_TO,
  NOTHING_TO_SEND,
  type DraftForComposer,
} from '@/modules/unified-inbox/lib/drafts'
import { describeSendAt, plainTextToHtml, toWallClock } from '@/modules/unified-inbox/lib/scheduled'
import { AttachmentChips, AttachmentPicker, plainReason, type Attachment } from './AttachmentPicker'
import { ProductPicker, productKey } from './ProductPicker'
import { AttachmentDropNotice, AttachmentDropOverlay } from './AttachmentDropChrome'
import { useAttachmentDrop } from './useAttachmentDrop'
import { ConfirmDialog } from './ConfirmDialog'
import { Dropdown } from './Dropdown'
import { PendingSend } from './PendingSend'
import { RecipientField } from './RecipientField'
import { RichText, RichTextBox, RichTextTools, type RichTextHandle } from './RichText'
import { ScheduleNotice } from './ScheduleNotice'
import { SendLaterPanel } from './SendLaterPanel'
import { SnoozePanel } from './SnoozePanel'
import { AlarmIcon, CloseIcon, CollapseIcon, ExpandIcon, PaperclipIcon, TagIcon } from './icons'
import { useComposerOpen } from './composer-open'
import type { DraftSendState } from '@/modules/unified-inbox/lib/types'
import type { ReplyStyle } from '@/modules/unified-inbox/lib/channel-reply'
import { appendSlots, refKey, slotHtml, slotRefs } from '@/modules/unified-inbox/lib/products/slots'
import type { ProductChoice } from '@/modules/unified-inbox/lib/products/types'
import { pickQuotedPreview, type QuotedPreview } from '@/modules/unified-inbox/lib/quoted-preview'
import { MessageBody } from './MessageBody'
import { MessageText } from './MessageText'

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
  /** How this conversation is answered: whether somebody types who it goes to,
   *  and what a reply on it can carry. See lib/channel-reply.ts - a channel
   *  another module owns takes words, back where they came from, and offering
   *  a To line, a formatting strip and a paperclip on one is offering three
   *  things that are quietly thrown away. */
  style: ReplyStyle
  /** Who the reply is going to, in words, for the conversations that decide it
   *  themselves. Printed where the To line would have been. Null on email,
   *  which says it in the box instead. */
  destinationLine: string | null
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
  /** Which message that press was made on - the one being answered, and so the
   *  one quoted under the answer. Null where the box was opened for the
   *  conversation rather than for a message in it, which means the newest. */
  requestedReplyToId?: string | null
  /** Every message on the conversation a reply could quote. The box shows the
   *  one it is actually quoting, folded away - see lib/quoted-preview.ts. */
  quotedPreviews: QuotedPreview[]
  timezone: string
}

export function Composer({
  threadId, inboxId, replyTo, replyAllTo, canReply, canForward, style, destinationLine, staff,
  cannotReplyReason, replySubject, forwardSubject, draft, canAddProducts, draftProducts,
  requestedMode, requestedAt, requestedReplyToId, quotedPreviews, timezone,
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
  //
  // A draft written before the catalogue went INTO the box carries its products
  // beside the words rather than in them, so they are run onto the end here.
  // That is where they used to print, and from this moment on they can be moved
  // about like everything else.
  const [text, setText] = useState(() => {
    const body = draft ? (draft.bodyFormat === 'html' ? draft.body : plainTextToHtml(draft.body)) : ''
    return slotRefs(body).length > 0 ? body : appendSlots(body, draftProducts)
  })

  // Which message is being answered. It travels with the send, and the server
  // quotes that message under the reply - so answering the fourth message of
  // nine no longer arrives with the ninth one's words underneath it.
  //
  // A draft remembers it too, because a reply saved on Tuesday and sent on
  // Friday still answers Tuesday's message. Null throughout means "the newest
  // message on the conversation", which is what the box does when it was opened
  // for the conversation rather than for anything in it.
  const [replyToId, setReplyToId] = useState<string | null>(
    () => requestedReplyToId ?? draft?.inReplyToMessageId ?? null,
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
  // block in the writing can say what they are; only the references are ever
  // sent, and what the customer reads is built on the server when Send is
  // pressed.
  //
  // The WRITING is what decides which products are on the message, though - this
  // follows it. Somebody who backspaces over a block has taken that product off,
  // and there is no second list that could disagree with what is on the screen.
  const [picked, setPicked] = useState<ProductChoice[]>(draftProducts)
  const [pickingProduct, setPickingProduct] = useState(false)
  const products = useMemo(() => {
    const known = new Map(picked.map((one) => [productKey(one), one]))
    return slotRefs(text)
      .map((ref) => known.get(refKey(ref)))
      .filter((one): one is ProductChoice => one !== undefined)
  }, [picked, text])
  /** The writing box, for putting a product where the caret is. */
  const editor = useRef<RichTextHandle | null>(null)
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
  // The chase set on it, the sleep waiting behind it, and whether mail from the
  // recipient took the timer off before it could go. All three travel with the
  // draft rather than being worked out here: the server decides what a saved
  // schedule means.
  const [followUpMinutes, setFollowUpMinutes] = useState<number | null>(draft?.followUpMinutes ?? null)
  const [draftSnoozeUntil, setDraftSnoozeUntil] = useState<string | null>(draft?.snoozeUntil ?? null)
  const [held, setHeld] = useState(draft?.held ?? false)
  // A time somebody has picked off the alarm clock and not yet committed. It is
  // deliberately not saved on the spot: "send it later" and "send it later and
  // put this conversation to sleep until then" are two instructions, and the
  // menu cannot know which one is coming.
  const [pendingSendAt, setPendingSendAt] = useState<Date | null>(null)
  // Read once and never set: nothing offers a chase any more. It is here so
  // that re-saving a draft written back when the composer did offer one keeps
  // the chase it was given rather than quietly dropping it.
  const [pendingFollowUp] = useState<number | null>(draft?.followUpMinutes ?? null)
  // Waiting for its own time, or going out this minute. Either way it is out of
  // this composer's hands.
  const waiting = sendState === 'scheduled' || sendState === 'sending'

  /** The chosen departure time in the shape the server reads it in: a wall
   *  clock with no zone on it, meant in the SITE's zone. */
  const pendingWallClock = pendingSendAt ? toWallClock(pendingSendAt, timezone) : null
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
      // A later press is a press on a message, so it re-aims what gets quoted.
      // Undefined is a caller that has nothing to say about it, which leaves
      // whatever the box was already answering.
      if (requestedReplyToId !== undefined) setReplyToId(requestedReplyToId)
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
  /** The message that will be quoted under this one, or null on a conversation
   *  with nothing quotable on it. The same rule the send route follows - what
   *  was pressed, else the newest - so the panel below is not describing a
   *  different message from the one that goes out. */
  const quoting = useMemo(
    () => pickQuotedPreview(quotedPreviews, replyToId),
    [quotedPreviews, replyToId],
  )
  /** Whether the panel below the words is actually open. A shut <details> still
   *  MOUNTS what is inside it - it only hides it - and what is inside this one
   *  is a frame that fetches a whole message and runs a script to measure
   *  itself. Every reply anybody started would have loaded a message nobody had
   *  asked to see. */
  const [showingQuoted, setShowingQuoted] = useState(false)
  /** The line the message is actually addressed by, whichever box it came out
   *  of. */
  const recipients = forwarding ? forwardTo : replyRecipients
  const setRecipients = forwarding
    ? (value: string) => { setForwardTo(value); setDirty(true) }
    : (value: string) => { setReplyRecipients(value); setRecipientsEdited(true); setDirty(true) }
  // Only where there is an address to be missing. On a conversation another
  // module owns nobody types one, the send route ignores `to` entirely, and
  // this used to disable Send, Send later and the snooze menu on every WhatsApp
  // message, text and call the hub had collected.
  const nobodyToSendTo = !noting && style.addressed && splitAddresses(recipients).length === 0

  /** What the subject would be if nobody touched it. Only ever shown once the
   *  Subject line has been opened - a reply with a subject nobody typed is what
   *  every reply has always been. */
  const defaultSubject = forwarding ? forwardSubject : replySubject

  /** A file dragged straight onto the box, rather than found in the library.
   *  Off for an internal note, which is not sent anywhere and has nothing to
   *  carry a file on, and off while something is in flight for the reason the
   *  chips are greyed then: a message on its way is not one to add to. */
  const drop = useAttachmentDrop({
    disabled: busy || noting || !style.attachments,
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

  /** Which sentence an empty To line earns here. Forwarding and replying are
   *  the same complaint about the same empty box, but a reply is not being
   *  forwarded and saying so would be a small lie. Named once so that the box
   *  can take its own warning down again once somebody has answered it. */
  const needsSomebody = mode === 'forward' ? NEEDS_SOMEBODY_TO_FORWARD_TO : NEEDS_A_RECIPIENT

  /** Takes down a complaint about an empty box now that the box has been
   *  filled in. Only that one sentence: a send that actually failed, or a
   *  different box still left blank, has nothing to do with what was just
   *  typed and must stay on screen. */
  const clearOnceAnswered = useCallback((answered: string) => {
    setError((shown) => (shown === answered ? '' : shown))
  }, [])

  const submit = useCallback(async (): Promise<boolean> => {
    if (!htmlHasWriting(text)) {
      setError(NOTHING_TO_SEND)
      return false
    }
    const to = splitAddresses(recipients)
    if (mode !== 'note' && style.addressed && to.length === 0) {
      setError(needsSomebody)
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
          body: JSON.stringify({
            text,
            mentions,
            // References only, same as a message: the note is built from what
            // the shop says when it is saved.
            products: products.map(({ moduleName, kind, id }) => ({ moduleName, kind, id })),
          }),
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
            // What is being answered or sent on, so the words quoted underneath
            // are that message's. Left out is the newest on the conversation,
            // which is what the box opened from the conversation itself means.
            inReplyToMessageId: replyToId ?? undefined,
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
      // empty and ready for the next reply, and chairs left over from a message
      // that has already gone are three chairs somebody sends twice. Emptying
      // the writing already took the blocks with it; this is what somebody
      // picked, which is what a second press would otherwise still find.
      setPicked([])
      setMentions([])
      setMentionQuery('')
      // Back to the newest message. What was just answered has an answer under
      // it now, and the empty box is the conversation's box again until
      // somebody presses the arrow on a particular message.
      setReplyToId(null)
      setDirty(false)
      // The draft went with the message, and so did any time on it - and any
      // sleep that was waiting behind that time.
      setSendAt(null)
      setSendState(null)
      setSendError(null)
      setDraftSnoozeUntil(null)
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
    attachments, bcc, cc, defaultRecipients, draftId, mentions, mode, needsSomebody, products,
    recipients, replyToId, router, style.addressed, subject, text, threadId,
  ])

  /** What a save sends. In one place because two things send it: the save that
   *  waits and reports, and the one that carries on after somebody has already
   *  walked off the screen. */
  const draftPayload = useCallback((
    wallClock?: string | null,
    followUp?: number | null,
    sleepUntil?: Date | null,
  ) => ({
    id: draftId ?? undefined,
    threadId,
    inReplyToMessageId: replyToId,
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
    // Same terms. The conversation is put to sleep here and now as well, but
    // that sleep has to survive a send that happens days later with nobody
    // watching, so the instruction rides on the draft too.
    snoozeUntil: sleepUntil ? sleepUntil.toISOString() : null,
  }), [
    attachments, bcc, cc, draftId, mode, products, recipients, replyToId, subject, text, threadId,
  ])

  /** Puts the box down as a draft, with or without a time on it. Saving and
   *  scheduling are one request on purpose: a scheduled message IS a draft with
   *  a departure time, and two requests would leave a window where the writing
   *  was saved and the time was not. `wallClock` null takes a time back off. */
  const save = useCallback(async (
    wallClock?: string | null,
    followUp?: number | null,
    sleepUntil?: Date | null,
  ): Promise<boolean> => {
    const payload = draftPayload(wallClock, followUp, sleepUntil)
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
      setDraftSnoozeUntil(typeof data?.snoozeUntil === 'string' ? data.snoozeUntil : null)
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
  }, [draftPayload, router])

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
      setDraftSnoozeUntil(null)
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

  /** Whether shutting the box is a question at all: there is writing that has
   *  not been put down, or there is a draft sitting under Drafts that somebody
   *  may want rid of. The second half is why the strip along the bottom no
   *  longer carries a "Throw the draft away" chip - the cross is the one place
   *  that question is asked now, and it has to be able to ask it about a draft
   *  that was saved a moment ago and not touched since. */
  // A time picked and not yet committed counts too: shutting the box on it
  // without asking is how somebody ends up with an ordinary draft where they
  // thought they had a message going out in the morning.
  const closeIsAQuestion = hasUnsaved || !!pendingWallClock || (!noting && !!draftId)

  /** The cross in the corner of the box, and the one on the popped-out window.
   *  With nothing to lose it simply shuts; otherwise it asks the one question
   *  worth asking - keep it, throw it away, or carry on writing - rather than
   *  the old question, which offered "Leave it" and quietly meant "lose it". */
  const askToClose = useCallback(() => {
    if (closeIsAQuestion) setClosing(true)
    else closeComposer()
  }, [closeComposer, closeIsAQuestion])

  /** Stops the save below being started twice while it is in flight - the
   *  effect it lives in re-runs whenever anything typed changes. */
  const leaving = useRef(false)

  /**
   * Put the draft down without anybody waiting for it.
   *
   * The screen has already moved by the time this answers, so it touches no
   * state and does not refresh the router: the box it would be talking to is
   * off the screen, and a refresh would be a reload of wherever somebody has
   * just arrived. `keepalive` so the request survives the page being closed
   * rather than a click that merely moves within it, and one retry - but ONLY
   * on a connection that dropped, never on an answer the server actually gave.
   * A new draft carries no id, so two requests that both land are two drafts; a
   * blip that loses somebody's writing is worse than that, and a refusal
   * repeated is only a refusal.
   *
   * A TIME PICKED OFF THE ALARM CLOCK TRAVELS WITH IT. It used to be dropped
   * here without a word: somebody chose "Tomorrow morning", clicked onto the
   * next conversation, and got an ordinary draft with no time on it and nothing
   * said about the one they picked. Picking a time is the instruction; the only
   * reason it is not written the moment it is picked is that "send it then" and
   * "send it then and put this to sleep" are two different presses, and neither
   * of those is a reason to throw the answer away when the screen moves.
   *
   * If the server refuses the TIME - a moment that has been and gone by the
   * time the request lands, an address nobody may send from any more - the same
   * writing goes again with no time on it, because a refusal must never cost
   * somebody the words. They get a draft rather than a scheduled message, which
   * is the smaller of the two losses and the one they can see.
   */
  const saveInBackground = useCallback(() => {
    const timed = draftPayload(pendingWallClock ?? undefined, pendingWallClock ? pendingFollowUp : undefined)
    if (!isWorthSaving(timed)) return
    const post = async (payload: ReturnType<typeof draftPayload>): Promise<boolean> => {
      const response = await fetch('/api/m/unified-inbox/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      })
      // The two failures told apart by which of them this is: a rejection is
      // the line, a false answer here is the server.
      return response.ok
    }
    void post(timed)
      .catch(() => post(timed))
      // A refusal with a time on it is tried once more without one, so the
      // writing survives a departure the server would not take.
      .then((ok) => (ok || !pendingWallClock ? ok : post(draftPayload())))
      // Said out loud in the one place there is left to say it. Nothing on
      // screen can be told: whoever wrote this is two screens away by now.
      .then((ok) => {
        if (!ok) console.error('[unified-inbox] a draft was refused on the way out')
      })
      .catch(() => console.error('[unified-inbox] a draft could not be put down on the way out'))
  }, [draftPayload, pendingFollowUp, pendingWallClock])

  // A click on a link that would take the screen somewhere else was caught by
  // the listener above. It used to raise a dialog asking whether to lose the
  // reply; now the reply is simply put down as a draft and the click carries
  // on, which is what every mail program does and what nobody has ever had to
  // be asked about.
  //
  // THE JOURNEY NO LONGER WAITS FOR THE SAVE. It used to: the request went, and
  // only when it came back did the screen move - which on a slow line, or a
  // draft carrying a dozen attachments, is a second or two of a page that looks
  // like it has ignored the click. The click is now honoured on the spot and the
  // draft is put down behind it. The cost is honest and small: a save that
  // fails after you have walked away can no longer stop you, so it retries
  // once and then says so in the browser's console rather than on a screen
  // nobody is looking at any more.
  //
  // A note is the exception, and gets the question instead: notes are not saved
  // as drafts - a draft is a message on its way out - so there is nothing to
  // put it down as, and walking off with it silently would lose it.
  useEffect(() => {
    if (noting) return
    if (!leavingTo || leaving.current) return
    leaving.current = true
    saveInBackground()
    const going = leavingTo
    setLeavingTo(null)
    leaving.current = false
    router.push(going)
  }, [leavingTo, noting, router, saveInBackground])

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

  /** The two ways out of the box: into a window of its own, and shut.
   *
   *  They used to sit on a strip along the top of the composer beside the word
   *  "Reply", which spent a whole row of the reading pane naming the button
   *  somebody had just pressed. The pair moved to the right-hand end of the
   *  line that already carries Cc, Bcc and Subject, which had the room and was
   *  where the eye already was.
   *
   *  Nothing at all when the box is popped out: the window's own head carries
   *  the same two, and drawing them twice is drawing a cross that shuts a
   *  different thing to the cross beside it. */
  const headTools = poppedOut ? null : (
    <>
      <button
        type="button"
        className="uin-icon-btn uin-composer-tool"
        aria-label="Open it in a window of its own"
        title="Open it in a window of its own"
        onClick={() => setPoppedOut(true)}
      >
        {ExpandIcon}
      </button>
      <button
        type="button"
        className="uin-icon-btn uin-composer-tool"
        aria-label="Close this reply"
        title="Close this reply"
        onClick={askToClose}
        disabled={busy}
      >
        {CloseIcon}
      </button>
    </>
  )

  const body = (
    // The provider rather than a box: the words are drawn in the middle of this
    // and the buttons that format them are drawn on the strip along the bottom,
    // and both of them have to be talking about the same box.
    <RichText
      id="uin-composer-text"
      handleRef={editor}
      value={text}
      onChange={(html) => {
        setText(html)
        setDirty(true)
        setNote('')
        if (htmlHasWriting(html)) clearOnceAnswered(NOTHING_TO_SEND)
      }}
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

      {noting ? (
        <div className="uin-composer-aside-row">
          <p className="uin-recipients uin-composer-aside">
            Only your colleagues see this. Nothing is sent to the customer.
          </p>
          {headTools && <span className="uin-field-links">{headTools}</span>}
        </div>
      ) : !style.addressed ? (
        /* A conversation another module owns is not addressed by hand: it goes
           back where it came from, and the four lines an email opens with - To,
           Cc, Bcc and Subject - are four boxes nothing on the server reads. In
           their place, one line saying who is about to receive it, which is the
           part of the To line that was ever worth having here. */
        <div className="uin-composer-aside-row">
          <p className="uin-recipients uin-composer-aside">
            {destinationLine ?? 'This goes back the way it came.'}
          </p>
          {headTools && <span className="uin-field-links">{headTools}</span>}
        </div>
      ) : (
        <div className="uin-fields">
          <div className="uin-field-row">
            <label htmlFor="uin-reply-to">To</label>
            <div className="uin-field-control">
              <RecipientField
                id="uin-reply-to"
                value={recipients}
                onChange={(next) => {
                  setRecipients(next)
                  if (splitAddresses(next).length > 0) clearOnceAnswered(needsSomebody)
                }}
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
                {headTools}
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

      {/* What goes out underneath the words, and until now the box said nothing
          whatever about it. The quotation itself is built when the message is
          actually sent - it has to be, since the markup that leaves is
          sanitised on its way out and a stranger's email never touches this
          page - so the only way to find out what a customer would receive was
          to send it and go and read your own copy.

          Folded away, and phrased the way the same fold is phrased on a message
          in the conversation above, because it is the same thing being said. It
          is shown rather than edited: what will be quoted is decided by which
          arrow was pressed, and a box somebody could type into would be a
          second copy of the message going out under the first.

          Only where a quotation is actually appended. A note is not sent to
          anybody, and a reply on a channel another module owns is handed over as
          one string with nothing beneath it. */}
      {!noting && style.addressed && quoting && (
        <details
          className="uin-quoted-preview"
          onToggle={(event) => setShowingQuoted(event.currentTarget.open)}
        >
          <summary className="uin-chip uin-summary">
            {forwarding ? 'Show what you are forwarding' : 'Show the earlier messages'}
          </summary>
          {showingQuoted && (
            <div className="uin-quoted-preview-body">
              {forwarding ? (
                <p className="uin-quoted-preview-line">
                  ---------- Forwarded message ----------
                  {quoting.forwardHeader.map(([label, value]) => (
                    <span key={label}><br />{label}: {value}</span>
                  ))}
                </p>
              ) : (
                <p className="uin-quoted-preview-line">{quoting.attribution}</p>
              )}
              {quoting.hasHtml ? (
                <MessageBody
                  messageId={quoting.id}
                  hasRemoteImages={quoting.hasRemoteImages}
                  ownSender={quoting.ownSender}
                  /* Opened rather than folded again. The point of the panel is
                     to see everything that goes out beneath the reply, and a
                     fold inside a fold hides exactly what was asked for. */
                  showQuoted
                />
              ) : (
                <MessageText
                  text={quoting.bodyText ?? '(this message had nothing in it)'}
                  foldQuoted={false}
                />
              )}
            </div>
          )}
        </details>
      )}

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

      {!noting && style.attachments && (
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
          snoozeUntil={draftSnoozeUntil}
          held={held}
          timezone={timezone}
        />
      )}

      {/* Drawn on a message already waiting for a time as well as on one being
          given its first: picking a new time off the clock has to show, and
          used to do nothing visible at all - the row and both buttons that
          commit it were hidden the moment a message was scheduled, so choosing
          a better time silently threw the choice away. */}
      {!noting && pendingSendAt && (
        <PendingSend
          at={pendingSendAt}
          replacing={waiting}
          onClear={() => setPendingSendAt(null)}
          timezone={timezone}
          busy={busy}
        />
      )}

      {error && <div className="alert alert-danger" role="alert">{error}</div>}
      {note && !error && <div className="alert alert-success" role="status">{note}</div>}

      {/* What is going with the message, on a line of its own above the strip.
          It used to sit in among the buttons, where three files pushed Send
          onto a second row and a long filename decided where everything else
          went. A row of its own costs nothing when there is nothing on it -
          there is no row at all - and keeps the strip below it still. */}
      {!noting && style.attachments && attachments.length > 0 && (
        <div className="uin-composer-row uin-attachment-row">
          <AttachmentChips
            attachments={attachments}
            disabled={busy}
            onRemove={(key) => {
              setAttachments((prev) => prev.filter((p) => p.key !== key))
              setDirty(true)
            }}
          />
        </div>
      )}

      {/* Everything you can do to the message, on one strip along the bottom -
          the place every mail program has kept it. What you do TO the message
          is on the left: the files, the catalogue, and the six formatting
          buttons, which used to sit in a strip of their own above the words and
          are the same six wherever they are drawn. The ways it leaves are on the
          right - the alarm clock among them, because when it goes is part of how
          it goes - and the gap between the two groups is deliberate.

          When the column is too narrow for one line, the send buttons wrap as a
          group and stay hard right - and if only one of them fits, it is the
          primary that keeps the first line, because that is the one somebody
          came to press. See uin-send-group in styles.tsx for how. */}
      <div className="uin-composer-row uin-composer-actions">
        {/* The paperclip only where a file would actually arrive. A reply on a
            channel another module owns is handed to it as one string, so an
            attachment on one was picked, uploaded, shown as a chip and then
            silently left behind by the send route. */}
        {!noting && style.attachments && (
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
        )}
        {/* On a note as well as on a reply. A note is where somebody asks a
            colleague about a chair, and on a discussion it is the only box there
            is - so leaving the catalogue off it meant the one conversation whose
            whole purpose is "look at this one" was the one that could not. What
            goes out is different, not what may be picked: a note prints the
            product as words on our own screen and puts it on the conversation's
            context line, and nothing is sent to anybody. */}
        {canAddProducts && (
          <button
            type="button"
            className="uin-icon-btn"
            title={noting
              ? 'Put something you sell in this note'
              : 'Put something you sell on this message'}
            aria-label={noting
              ? 'Put something you sell in this note'
              : 'Put something you sell on this message'}
            onClick={() => setPickingProduct(true)}
            disabled={busy}
          >
            {TagIcon}
          </button>
        )}

        {/* The formatting strip, cut to what will actually arrive. An email
            carries the lot. A channel carries whatever it declared and nothing
            else - WhatsApp has bold, italic and strikethrough, written with a
            marker rather than a tag, and has no colour, no link with words of
            its own and no bullet list at all - so those three buttons are
            drawn and the other three are not. A channel that declared nothing
            takes plain words and gets no strip. A note keeps the whole strip
            whatever the conversation is: it is never sent anywhere, and it is
            drawn as markup on this screen. */}
        {noting || style.richText ? (
          <RichTextTools />
        ) : style.styles.length > 0 ? (
          <RichTextTools styles={style.styles} />
        ) : null}

        <span className="uin-composer-gap" />

        {/* Nothing here for throwing the draft away. It used to be a chip on
            this strip, which put a destructive button a thumb away from Send
            and asked the question in a second place - the cross in the corner
            already asks it, and asks it the way the new-message box does:
            keep it, throw it away, or carry on writing. */}
        <span className="uin-send-group">
          {/* When it goes out, on the alarm clock rather than in words, and at
              the left-hand end of the group that sends things - which is where
              the decision belongs: choosing a time changes what the two buttons
              beside it do, and it used to sit at the far end of the strip beside
              the paperclip, a foot away from the thing it changed.

              The menu also stands a time back down again, which is why it is
              still here on a message already waiting for one. */}
          {!noting && (
            <Dropdown
              className="uin-icon-btn"
              label={AlarmIcon}
              ariaLabel={waiting ? 'Change when this goes out' : 'Choose when this goes out'}
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

          {/* One pair of buttons whatever has been decided, rather than a third
              one appearing beside them. A time picked off the clock changes what
              these two SAY and what they do - "Send later", "Send later &
              snooze" - because that is what picking it changed. There used to be
              a separate "Save it for then" here, which meant three ways to send
              on one strip and two of them a thumb apart. */}
          {!noting && (
            <Dropdown
              className="btn btn-secondary btn-sm"
              label={pendingWallClock ? 'Send later & snooze' : 'Send & snooze'}
              align="end"
              width={280}
              panelClassName="uin-menu-snooze"
              disabled={busy || nobodyToSendTo}
            >
              <SnoozePanel
                timezone={timezone}
                busy={busy}
                title={pendingWallClock ? 'Set it going, then sleep until' : 'Send it, then sleep until'}
                onSnooze={(until) => {
                  // With a time on it nothing is sent now: the departure is
                  // saved and the conversation goes to sleep behind it.
                  //
                  // The sleep is written in BOTH places on purpose. Here, so the
                  // conversation leaves the list this minute, which is what was
                  // asked for; and on the draft, so that when the message
                  // actually goes out - days later, with nobody watching - the
                  // queue knows to put it back to sleep rather than leaving the
                  // conversation open on the strength of what it happened to
                  // find. See lib/follow-up.ts.
                  if (pendingWallClock) {
                    void save(pendingWallClock, pendingFollowUp, until)
                      .then((ok) => { if (ok) void snoozeThread(until) })
                    return
                  }
                  void submit().then((ok) => { if (ok) void snoozeThread(until) })
                }}
              />
            </Dropdown>
          )}

          {/* A message already waiting for its time, that has been edited since.
              Its own button because the other two commit a decision - send it,
              send it then - and this one commits nothing but the writing: the
              departure time it already has is left exactly where it is. Without
              it there was no way at all to correct a scheduled message and keep
              the time, and the writing quietly rode out on whatever saved it
              next. */}
          {!noting && waiting && !pendingWallClock && hasUnsaved && (
            <button
              type="button"
              className="uin-chip"
              disabled={busy}
              onClick={() => { void save() }}
            >
              {busyWith === 'save' ? 'Saving...' : 'Save changes'}
            </button>
          )}

          {/* One button, always: with a time picked it commits that time, and on
              a message already waiting for one it is the way to send it by hand
              after all. It used to disappear the moment a message was
              scheduled, which left "send it now instead" as no answer at
              all. */}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              if (!noting && pendingWallClock) {
                void save(pendingWallClock, pendingFollowUp)
                return
              }
              void submit()
            }}
            // Nothing to send to means the server would refuse it anyway, and
            // finding that out by pressing Send is finding it out too late.
            disabled={busy || nobodyToSendTo}
          >
            {busyWith === 'send' || (busyWith === 'save' && pendingWallClock)
              ? (noting ? 'Saving...' : 'Sending...')
              : noting ? 'Save note' : pendingWallClock ? 'Send later' : 'Send now'}
          </button>
        </span>
      </div>

      {/* Left open after a pick, like the catalogue below it: attaching six
          files is one errand, and a dialog that shut itself after the first
          would be five more trips into it. */}
      {picking && (
        <AttachmentPicker
          drop={drop}
          attached={attachments}
          onRemove={(key) => {
            setAttachments((prev) => prev.filter((p) => p.key !== key))
            setDirty(true)
          }}
          onClose={() => setPicking(false)}
          onPick={(item) => {
            setAttachments((prev) =>
              prev.some((a) => a.key === item.key) ? prev : [...prev, item],
            )
            setDirty(true)
          }}
        />
      )}

      {/* Left open after a pick as well: quoting somebody three chairs is one
          errand, not three trips into the catalogue. */}
      {pickingProduct && (
        <ProductPicker
          chosen={products}
          onClose={() => setPickingProduct(false)}
          onPick={(item) => {
            // Into the writing, where the caret is. The block that lands there
            // is what the recipient will see, so the message can be built round
            // it - "this one is the cheapest", the chair, "and this one is what
            // you asked for" - rather than everything ending up under
            // everything.
            setPicked((prev) =>
              prev.some((p) => productKey(p) === productKey(item)) ? prev : [...prev, item],
            )
            editor.current?.insertHtml(slotHtml(item))
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
          // Three situations now. A time picked off the alarm clock and not yet
          // committed is kept rather than dropped - it is what the person
          // answered when they were asked when it should go - so the question
          // and both answers say what is actually about to happen, instead of
          // offering to "keep this as a draft" and quietly binning the time.
          title={pendingWallClock ? 'Set it going?' : 'Keep this as a draft?'}
          // Two situations, and one of them is new: the cross now asks about a
          // draft that was saved a minute ago and not touched since, because
          // the chip that used to throw one away has gone off the strip. There
          // is nothing to save in that case, so it does not offer to.
          body={pendingWallClock
            ? `Nothing has been sent yet. It goes out ${describeSendAt(pendingSendAt, new Date(), timezone)} on its own, and waits under Scheduled until then - where you can still change it, move it or stop it.`
            : hasUnsaved
            ? 'Nothing here has been sent. It can wait under Drafts, and here, until you come back to it.'
            : 'It is already waiting under Drafts, and here, until you come back to it.'}
          confirmLabel={pendingWallClock
            ? 'Save it and set it going'
            : hasUnsaved ? 'Save it as a draft' : 'Leave it as a draft'}
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
            // Nothing typed and no time waiting to be set: there is genuinely
            // nothing to write down, and the box simply shuts.
            if (!hasUnsaved && !pendingWallClock) { setClosing(false); closeComposer(); return }
            void save(pendingWallClock ?? undefined, pendingFollowUp).then((ok) => {
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
