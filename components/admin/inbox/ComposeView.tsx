'use client'

import {
  useCallback, useEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { inboxHref } from '@/modules/unified-inbox/lib/list'
import {
  htmlHasWriting,
  isWorthSaving,
  splitAddresses,
  NEEDS_A_RECIPIENT,
  NEEDS_A_SUBJECT,
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
import { AlarmIcon, CloseIcon, PaperclipIcon, TagIcon } from './icons'
import type { DraftSendState } from '@/modules/unified-inbox/lib/types'
import { appendSlots, refKey, slotHtml, slotRefs } from '@/modules/unified-inbox/lib/products/slots'
import type { ProductChoice } from '@/modules/unified-inbox/lib/products/types'

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
  /** Whether this person can put anything out of the catalogue on a message:
   *  the site sells something, and they are allowed to see what. Worked out on
   *  the server, because the answer is a permission rather than a preference. */
  canAddProducts: boolean
  /** The products the draft was carrying, already looked up - names, pictures
   *  and today's prices. The draft itself remembers only which. */
  draftProducts: ProductChoice[]
  timezone: string
}

export function ComposeView({
  base, params, inboxes, defaultInboxId, draft, canAddProducts, draftProducts, timezone,
}: Props) {
  const router = useRouter()
  const [inboxId, setInboxId] = useState(draft?.inboxId ?? defaultInboxId ?? '')
  const [to, setTo] = useState((draft?.to ?? []).join(', '))
  const [cc, setCc] = useState((draft?.cc ?? []).join(', '))
  const [showCc, setShowCc] = useState((draft?.cc ?? []).length > 0)
  // The copy nobody else on the message sees. Its own line, opened by its own
  // link, and never folded in with Cc - that separation is the whole of what a
  // blind copy is.
  const [bcc, setBcc] = useState((draft?.bcc ?? []).join(', '))
  const [showBcc, setShowBcc] = useState((draft?.bcc ?? []).length > 0)
  const [subject, setSubject] = useState(draft?.subject ?? '')
  // The markup in the writing box. A draft written before the box could hold
  // any is turned into markup on the way in, so its line breaks survive - and a
  // draft written before the catalogue went INTO the box has its products run
  // onto the end, which is where they used to print.
  const [text, setText] = useState(() => {
    const body = draft ? (draft.bodyFormat === 'html' ? draft.body : plainTextToHtml(draft.body)) : ''
    return slotRefs(body).length > 0 ? body : appendSlots(body, draftProducts)
  })
  const [attachments, setAttachments] = useState<Attachment[]>(
    (draft?.attachments ?? []).map((file) => ({ ...file, sizeBytes: file.sizeBytes ?? null })),
  )
  const [picking, setPicking] = useState(false)
  // What the message carries out of the catalogue. Held as whole products
  // rather than as references, because the block in the writing has to say what
  // they are - but only the references are ever sent, and what a customer reads
  // is built on the server from what the shop says at that moment.
  //
  // The WRITING decides which products are on it, though - this follows it. A
  // block somebody backspaced over is a product taken off, and there is no
  // second list that could disagree with what is on the screen.
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
  // Which job is in flight, rather than merely that one is: a button that says
  // "Saving..." while somebody is sending is a button telling a small lie.
  const [busyWith, setBusyWith] = useState<'send' | 'save' | 'discard' | null>(null)
  const busy = busyWith !== null
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  // Which question is on screen: whether to keep what has been typed, or
  // whether to throw a draft that was already saved away. Two different losses,
  // two different sentences.
  const [asking, setAsking] = useState<'leave' | 'discard' | null>(null)
  // Held rather than read from the address, because the first save mints it and
  // the second must land on the same row - four presses of Save are one draft.
  const [draftId, setDraftId] = useState<string | null>(draft?.id ?? null)
  // When this one is set to go out on its own, and how the last attempt went.
  // Held here so a time set in this dialog shows before the screen behind it
  // has been redrawn.
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
  // A time picked off the alarm clock and not committed yet. The reply box
  // makes the same bargain for the same reason: picking a time and deciding
  // what that time means are one moment's thinking, and a menu that saved on
  // the first click would have to guess which was meant.
  const [pendingSendAt, setPendingSendAt] = useState<Date | null>(null)
  // Read once and never set: nothing offers a chase any more. It is here so that
  // re-saving a draft written back when the composer did offer one keeps the
  // chase it was given rather than quietly dropping it.
  const [pendingFollowUp] = useState<number | null>(draft?.followUpMinutes ?? null)
  // Waiting for its own time, or going out this minute. Either way it is out of
  // this composer's hands.
  const waiting = sendState === 'scheduled' || sendState === 'sending'
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
    || bcc.trim().length > 0
    || subject.trim().length > 0
    || htmlHasWriting(text)
    || attachments.length > 0
    || products.length > 0
  )

  const leave = useCallback(() => { router.push(closeHref) }, [closeHref, router])

  /** Every way out that is not Send: Escape and the cross. Half a written
   *  message is not something to lose to one keystroke, so when there is
   *  something to lose the question is asked first - and the question offers to
   *  KEEP it, which is what somebody closing a half-written message nearly
   *  always wants and what the old two-answer version could not do. */
  const askToLeave = useCallback(() => {
    // A time picked and not yet committed counts as something to lose: leaving
    // on it without a word is how somebody ends up with an ordinary draft where
    // they thought they had a message going out in the morning.
    if (hasUnsaved || pendingSendAt) setAsking('leave')
    else leave()
  }, [hasUnsaved, leave, pendingSendAt])

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
    // A picked time is a loss of the same kind: nothing on the row says it,
    // and the message somebody believes is going out in the morning is not.
    if (!hasUnsaved && !pendingSendAt) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [hasUnsaved, pendingSendAt])

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

  /** Takes down a complaint about an empty box now that the box has been
   *  filled in. Only that one sentence: a send that actually failed, or a
   *  different box still left blank, has nothing to do with what was just
   *  typed and must stay on screen. */
  const clearOnceAnswered = useCallback((answered: string) => {
    setError((shown) => (shown === answered ? '' : shown))
  }, [])

  /** Sends it. `snoozeUntil` sends it and then puts the conversation it just
   *  started to sleep - which only makes sense once there IS one, which is why
   *  this is where it happens rather than in a second press afterwards. */
  const submit = useCallback(async (snoozeUntil?: Date) => {
    if (!inboxId) {
      setError('Pick which of your addresses this should come from.')
      return
    }
    const recipients = splitAddresses(to)
    if (recipients.length === 0) {
      setError(NEEDS_A_RECIPIENT)
      return
    }
    if (!subject.trim()) {
      setError(NEEDS_A_SUBJECT)
      return
    }
    if (!htmlHasWriting(text)) {
      setError(NOTHING_TO_SEND)
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
          bcc: splitAddresses(bcc),
          subject: subject.trim(),
          // Already markup. It is sanitised on the server, at the last gate
          // before it leaves, exactly as a pasted signature is.
          bodyHtml: text,
          attachments: attachments.map(({ key, url, filename, contentType }) => ({
            key, url, filename, contentType,
          })),
          products: products.map(({ moduleName, kind, id }) => ({ moduleName, kind, id })),
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
      // Put to sleep before the screen moves, so the conversation it lands on
      // is already showing what was asked for. Its own small request: the
      // message has gone either way, and a conversation that failed to go quiet
      // is not a message that failed to send.
      if (snoozeUntil && typeof data?.threadId === 'string') {
        try {
          await fetch(`/api/m/unified-inbox/threads/${data.threadId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'snoozed', snoozeUntil: snoozeUntil.toISOString() }),
          })
        } catch {
          // Said on the conversation it lands on, which is where somebody can
          // do something about it. Nothing is lost: the message went.
        }
      }
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
  }, [attachments, base, bcc, cc, draftId, inboxId, params, products, router, subject, text, to])

  /** Puts the screenful down as a draft, with or without a time on it. One
   *  request for both, because a scheduled message IS a draft with a departure
   *  time - two requests would leave a window where the writing was saved and
   *  the time was not.
   *
   *  Says whether it saved, because the cross in the corner offers to keep the
   *  message and then close - and closing on a save that did not happen is the
   *  loss the question was asked to prevent. */
  const save = useCallback(async (
    wallClock?: string | null,
    followUp?: number | null,
    sleepUntil?: Date | null,
  ): Promise<boolean> => {
    const payload = {
      id: draftId ?? undefined,
      inboxId: inboxId || null,
      mode: 'new' as const,
      to: splitAddresses(to),
      cc: splitAddresses(cc),
      bcc: splitAddresses(bcc),
      subject: subject.trim() || null,
      body: text,
      bodyFormat: 'html' as const,
      attachments: attachments.map(({ key, url, filename, contentType, sizeBytes }) => ({
        key, url, filename, contentType, sizeBytes,
      })),
      products: products.map(({ moduleName, kind, id }) => ({ moduleName, kind, id })),
      // Undefined is dropped by JSON.stringify, which is what "leave whatever
      // time is on it" looks like on the wire. A string sets one, null takes
      // it off.
      sendAt: wallClock,
      // Read by the server only when a time is being set, and cleared with the
      // time when one is taken off.
      followUpMinutes: followUp ?? null,
      // Where a message starting a conversation has to keep "and I do not want
      // to see it again until Friday": there is no conversation to put to sleep
      // until the queue has sent this, days from now with nobody watching, so
      // the instruction travels on the draft and is carried out at that end.
      // See lib/follow-up.ts.
      snoozeUntil: sleepUntil ? sleepUntil.toISOString() : null,
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
      // What came back rather than what was asked for: the server decides what
      // a typed time means.
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
        ? 'Saved, and set to go out on its own. It waits under Drafts until then.'
        : 'Saved. It is waiting under Drafts.')
      // The Drafts tab carries a count, and it is drawn on the server.
      router.refresh()
      return true
    } catch {
      setError('The site could not be reached. Nothing was saved.')
      return false
    } finally {
      inFlight.current = false
      setBusyWith(null)
    }
  }, [attachments, bcc, cc, draftId, inboxId, products, router, subject, text, to])

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
              if ((!hasUnsaved && !pendingSendAt) || opensElsewhere(event)) return
              event.preventDefault()
              setAsking('leave')
            }}
          >
            {CloseIcon}
          </Link>
        </div>

        <div className="uin-modal-body">
          {/* The provider rather than a plain box: the words are drawn in the
              middle of this and the buttons that format them are drawn on the
              strip along the bottom, and both have to mean the same box. */}
          <RichText
            id="uin-new-text"
            handleRef={editor}
            value={text}
            onChange={(html) => {
              setText(html)
              setDirty(true)
              setNote('')
              if (htmlHasWriting(html)) clearOnceAnswered(NOTHING_TO_SEND)
            }}
            placeholder="Write your message"
            label="Your message"
          >
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
                    onChange={(next) => {
                      setTo(next)
                      setDirty(true)
                      if (splitAddresses(next).length > 0) clearOnceAnswered(NEEDS_A_RECIPIENT)
                    }}
                    inboxId={inboxId || null}
                    onEnter={onLineKeyDown(showCc ? 'uin-new-cc' : showBcc ? 'uin-new-bcc' : 'uin-new-subject')}
                    placeholder="name@example.com, somebody.else@example.com"
                  />
                  <div className="uin-field-links">
                    {!showCc && (
                      <button type="button" className="uin-field-add" onClick={() => setShowCc(true)}>
                        Cc
                      </button>
                    )}
                    {!showBcc && (
                      <button type="button" className="uin-field-add" onClick={() => setShowBcc(true)}>
                        Bcc
                      </button>
                    )}
                  </div>
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
                      onEnter={onLineKeyDown(showBcc ? 'uin-new-bcc' : 'uin-new-subject')}
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

              {showBcc && (
                <div className="uin-field-row">
                  <label htmlFor="uin-new-bcc">Bcc</label>
                  <div className="uin-field-control">
                    <RecipientField
                      id="uin-new-bcc"
                      value={bcc}
                      onChange={(next) => { setBcc(next); setDirty(true) }}
                      inboxId={inboxId || null}
                      onEnter={onLineKeyDown('uin-new-subject')}
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

              <div className="uin-field-row">
                <label htmlFor="uin-new-subject">Subject</label>
                <div className="uin-field-control">
                  <input
                    id="uin-new-subject"
                    type="text"
                    value={subject}
                    onChange={(e) => {
                      setSubject(e.target.value)
                      setDirty(true)
                      if (e.target.value.trim()) clearOnceAnswered(NEEDS_A_SUBJECT)
                    }}
                    onKeyDown={onLineKeyDown('uin-new-text')}
                    placeholder="What it is about"
                    autoComplete="off"
                  />
                </div>
              </div>
            </div>

            <div className="uin-compose-message">
              <RichTextBox />
            </div>

            <AttachmentDropNotice
              progress={drop.progress}
              errors={drop.errors}
              dismissErrors={drop.dismissErrors}
            />

            <ScheduleNotice
              sendAt={sendAt}
              sendState={sendState}
              sendError={sendError}
              followUpMinutes={followUpMinutes}
              snoozeUntil={draftSnoozeUntil}
              held={held}
              timezone={timezone}
            />

            {/* Drawn on a message already waiting for a time as well as on one
                being given its first: picking a new time off the clock has to
                show. It used to be hidden the moment a message was scheduled,
                along with both buttons that commit it, so choosing a better
                time silently threw the choice away. */}
            {pendingSendAt && (
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

            {/* What is going with the message, on a line of its own above the
                strip. It used to sit in among the buttons, where three files
                pushed Send onto a second row and a long filename decided where
                everything else went. */}
            {attachments.length > 0 && (
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

            {/* The same strip the reply box has, for the same reason: what you
                do TO the message is on the left - the files, the catalogue, when
                it leaves, and the six formatting buttons that used to sit above
                the words - the ways it leaves are on the right, and the gap
                between them keeps the two from reading as one long row.

                Narrow, the send buttons wrap as a group and stay hard right, and
                if only one of them fits it is the primary that keeps the first
                line. See uin-send-group in styles.tsx. */}
            <div className="uin-composer-row uin-composer-actions">
              <button
                type="button"
                className="uin-icon-btn"
                title="Attach a file, or drag one onto this message"
                aria-label="Attach a file, or drag one onto this message"
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
              <RichTextTools />

              <span className="uin-composer-gap" />

              {/* A message with a time on it has already been decided about, so
                  while it waits the notice above is the whole of what is left to
                  do: move it, or cancel the timer. Cancel has gone from this row
                  altogether - the cross in the corner is the way out, and it
                  offers to keep what was typed rather than binning it. */}
              {draftId && (
                <button
                  type="button"
                  className="uin-chip"
                  onClick={() => setAsking('discard')}
                  disabled={busy}
                >
                  {busyWith === 'discard' ? 'Throwing it away...' : 'Throw the draft away'}
                </button>
              )}

              <span className="uin-send-group">
                {/* When it goes out, on the alarm clock and at the left-hand end
                    of the group that sends things - the same strip the reply box
                    has, and for the same reason: choosing a time changes what
                    the buttons beside it say and do, so it belongs next to them
                    rather than at the far end of the row beside the paperclip. */}
                <Dropdown
                  className="uin-icon-btn"
                  label={AlarmIcon}
                  ariaLabel={waiting ? 'Change when this goes out' : 'Choose when this goes out'}
                  title={waiting ? 'Change when this goes out' : 'Choose when this goes out'}
                  width={280}
                  panelClassName="uin-menu-snooze"
                  disabled={busy}
                >
                  <SendLaterPanel
                    timezone={timezone}
                    busy={busy}
                    scheduled={waiting}
                    onPick={(at) => { setPendingSendAt(at); setError('') }}
                    onCancelTimer={() => { setPendingSendAt(null); void save(null) }}
                  />
                </Dropdown>

                {/* One pair of buttons whatever has been decided, the same pair
                    the reply box has. A time picked off the clock changes what
                    these two SAY and what they do - "Send later", "Send later &
                    snooze" - rather than taking one of them away, which is what
                    used to happen: picking a time quietly cost you the ability
                    to put the conversation to sleep, and left a chase in its
                    place, which is a different instruction wearing its coat.

                    A message starting a conversation has no conversation yet, so
                    the sleep cannot be set here and now the way the reply box
                    sets it. It rides on the draft instead and is applied to the
                    conversation this message creates, at the moment it is
                    created. See lib/follow-up.ts. */}
                <Dropdown
                  className="btn btn-secondary btn-sm"
                  label={pendingSendAt ? 'Send later & snooze' : 'Send & snooze'}
                  align="end"
                  width={280}
                  panelClassName="uin-menu-snooze"
                  disabled={busy}
                >
                  <SnoozePanel
                    timezone={timezone}
                    busy={busy}
                    title={pendingSendAt ? 'Set it going, then sleep until' : 'Send it, then sleep until'}
                    onSnooze={(until) => {
                      // With a time on it nothing is sent now: the departure
                      // is saved, and the sleep is saved alongside it for the
                      // queue to apply once the message has actually gone.
                      if (pendingSendAt) {
                        void save(toWallClock(pendingSendAt, timezone), pendingFollowUp, until)
                        return
                      }
                      void submit(until)
                    }}
                  />
                </Dropdown>

                {/* A message already waiting for its time, that has been edited
                    since. Its own button, because the two beside it commit a
                    decision - send it, send it then - and this one commits
                    nothing but the writing: the time it already has is left
                    exactly where it is. Without it there was no way to correct a
                    scheduled message and keep its time. */}
                {waiting && !pendingSendAt && hasUnsaved && (
                  <button
                    type="button"
                    className="uin-chip"
                    disabled={busy}
                    onClick={() => { void save() }}
                  >
                    {busyWith === 'save' ? 'Saving...' : 'Save changes'}
                  </button>
                )}

                {/* One button, whichever was decided. A time picked off the clock
                    changes what this one says and what it does rather than adding
                    a second button beside it saying almost the same thing - and
                    on a message already set to go it is how you send it by hand
                    after all, which used to be no answer at all: the button was
                    taken off the strip the moment a time was on the row. */}
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    if (pendingSendAt) {
                      void save(toWallClock(pendingSendAt, timezone), pendingFollowUp)
                      return
                    }
                    void submit()
                  }}
                  disabled={busy}
                >
                  {busyWith === 'send' || (busyWith === 'save' && pendingSendAt)
                    ? 'Sending...'
                    : pendingSendAt ? 'Send later' : 'Send now'}
                </button>
              </span>
            </div>

            {/* Left open after a pick, like the catalogue below it: attaching
                six files is one errand, and a dialog that shut itself after the
                first would be five more trips into it. */}
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

            {/* Left open after a pick as well. Quoting somebody three chairs is
                one errand, and shutting the catalogue between each of them is
                three trips back into it. */}
            {pickingProduct && (
              <ProductPicker
                chosen={products}
                onClose={() => setPickingProduct(false)}
                onPick={(item) => {
                  // Into the writing, where the caret is - see the same handler
                  // on the reply box. The block that lands there is what the
                  // recipient will see, so the message can be built round it.
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
        </div>
      </div>

      {/* Three answers, because the question has three. It used to have two,
          and the first of them - "Leave it" - threw away a screenful of typing
          without ever using the word. */}
      <ConfirmDialog
        open={asking === 'leave'}
        /* A message already set to go out is not being kept as a draft - it is
           going out whatever this dialog decides - so it is asked about in its
           own words. Saying "keep this as a draft" over the top of a message
           leaving on Monday describes the wrong thing entirely. */
        title={pendingSendAt ? 'Set it going?' : waiting ? 'Keep the changes?' : 'Keep this as a draft?'}
        body={pendingSendAt
          // A time picked off the alarm clock and not committed is KEPT rather
          // than dropped: it is what somebody answered when they were asked
          // when it should go, and binning it silently is how a message people
          // believe is going out in the morning turns out to be a draft.
          ? `Nothing has been sent yet. It goes out ${describeSendAt(pendingSendAt, new Date(), timezone)} on its own, and waits under Scheduled until then - where you can still change it, move it or stop it.`
          : waiting
          ? 'This one is still set to go out on its own. Saving keeps what you have changed and leaves the time exactly where it is.'
          : 'Nothing here has been sent. It can wait under Drafts until you come back to it.'}
        confirmLabel={pendingSendAt
          ? 'Save it and set it going'
          : waiting ? 'Save the changes' : 'Save it as a draft'}
        cancelLabel="Keep writing"
        busy={busy}
        other={{
          label: 'Throw it away',
          destructive: true,
          onClick: () => {
            setAsking(null)
            setDirty(false)
            // A draft saved earlier goes with it; one never saved has nothing
            // to delete, and the dialog simply closes.
            if (draftId) void discard()
            else leave()
          },
        }}
        onCancel={() => { if (!busy) setAsking(null) }}
        onConfirm={() => {
          void save(
            pendingSendAt ? toWallClock(pendingSendAt, timezone) : undefined,
            pendingFollowUp,
          ).then((ok) => {
            setAsking(null)
            // A save that did not happen leaves the screen where it is, with
            // the reason on it. Closing anyway would be the exact loss this
            // question was asked to prevent.
            if (ok) leave()
          })
        }}
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
