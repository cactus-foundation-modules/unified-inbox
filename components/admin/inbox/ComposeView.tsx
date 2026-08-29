'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { inboxHref } from '@/modules/unified-inbox/lib/list'
import { isWorthSaving, splitAddresses, type DraftForComposer } from '@/modules/unified-inbox/lib/drafts'
import { AttachmentChips, AttachmentPicker, toHtml, type Attachment } from './AttachmentPicker'
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  // Held rather than read from the address, because the first save mints it and
  // the second must land on the same row - four presses of Save are one draft.
  const [draftId, setDraftId] = useState<string | null>(draft?.id ?? null)

  // One token per screenful, exactly as the reply composer carries: a double
  // press, or a retry after a timeout that may or may not have arrived, is one
  // email rather than two (E14). Nothing regenerates it here, because a message
  // that has genuinely gone leaves this screen altogether.
  const token = useRef(crypto.randomUUID())

  const closeHref = inboxHref(base, params, {})
  const chosen = inboxes.find((i) => i.id === inboxId) ?? null

  const card = useRef<HTMLDivElement>(null)

  // A dialog is a dialog: Escape shuts it, the page behind it does not scroll
  // under it, and the keyboard starts in the box rather than back at the top of
  // the admin. Nothing shuts it by accident though - the backdrop is deaf on
  // purpose, because a stray click that loses a half-written email is a worse
  // bargain than one more click on Cancel.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') router.push(closeHref)
    }
    document.addEventListener('keydown', onKeyDown)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // Whoever it is going to, which is the first thing anybody types. A fresh
    // message opens there; one being finished opens on what it says instead.
    const first = card.current?.querySelector<HTMLElement>(
      draft?.id ? '#uin-new-text' : '#uin-new-to',
    )
    first?.focus()
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previous
    }
  }, [closeHref, draft?.id, router])

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
    setBusy(true)
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
        setError(data?.error ?? 'That message could not be sent.')
        return
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
      setBusy(false)
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
    setBusy(true)
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
        setError(data?.error ?? 'That draft could not be saved.')
        return
      }
      if (data?.id) setDraftId(data.id as string)
      setNote('Saved. It is waiting under Drafts.')
      // The Drafts tab carries a count, and it is drawn on the server.
      router.refresh()
    } catch {
      setError('The site could not be reached. Nothing was saved.')
    } finally {
      setBusy(false)
    }
  }, [attachments, cc, draftId, inboxId, router, subject, text, to])

  const discard = useCallback(async () => {
    if (!draftId) {
      router.push(closeHref)
      return
    }
    setBusy(true)
    setError('')
    try {
      await fetch(`/api/m/unified-inbox/drafts/${draftId}`, { method: 'DELETE' })
      router.push(closeHref)
      router.refresh()
    } catch {
      setError('The site could not be reached. Nothing was thrown away.')
    } finally {
      setBusy(false)
    }
  }, [closeHref, draftId, router])

  return (
    <div className="uin-modal">
      <div
        className="uin-modal-card uin-modal-card-compose"
        role="dialog"
        aria-modal="true"
        aria-labelledby="uin-compose-title"
        ref={card}
      >
        <div className="uin-modal-head">
          <h2 className="uin-modal-title" id="uin-compose-title">
            {draftId ? 'A message you started' : 'A new message'}
          </h2>
          <a className="uin-modal-close" href={closeHref} aria-label="Close without sending">
            {CloseIcon}
          </a>
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
                    onChange={(e) => { setInboxId(e.target.value); setError(''); setNote('') }}
                  >
                    {inboxes.map((inbox) => (
                      <option key={inbox.id} value={inbox.id}>
                        {inbox.name} ({inbox.address})
                      </option>
                    ))}
                  </select>
                  {chosen && (
                    <span className="uin-field-hint">
                      replies land back in {chosen.name}
                    </span>
                  )}
                </div>
              </div>

              <div className="uin-field-row">
                <label htmlFor="uin-new-to">To</label>
                <div className="uin-field-control">
                  <input
                    id="uin-new-to"
                    type="text"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    placeholder="name@example.com, somebody.else@example.com"
                    autoComplete="off"
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
                    <input
                      id="uin-new-cc"
                      type="text"
                      value={cc}
                      onChange={(e) => setCc(e.target.value)}
                      placeholder="somebody.else@example.com"
                      autoComplete="off"
                    />
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
                    onChange={(e) => setSubject(e.target.value)}
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
                onChange={(e) => { setText(e.target.value); setNote('') }}
                placeholder="Write your message"
              />
            </div>

            <div className="uin-composer-row">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPicking(true)}>
                Attach a file
              </button>
              <AttachmentChips
                attachments={attachments}
                onRemove={(key) => setAttachments((prev) => prev.filter((p) => p.key !== key))}
              />
            </div>

            {error && <div className="alert alert-danger">{error}</div>}
            {note && !error && <div className="alert alert-success">{note}</div>}

            <div className="uin-composer-row">
              <button type="button" className="btn btn-primary btn-sm" onClick={submit} disabled={busy}>
                {busy ? 'Sending...' : 'Send'}
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={save} disabled={busy}>
                Save as a draft
              </button>
              {draftId ? (
                <button type="button" className="uin-chip" onClick={discard} disabled={busy}>
                  Throw the draft away
                </button>
              ) : (
                <a className="uin-chip" href={closeHref}>Cancel</a>
              )}
            </div>

            {picking && (
              <AttachmentPicker
                onClose={() => setPicking(false)}
                onPick={(item) => {
                  setAttachments((prev) =>
                    prev.some((a) => a.key === item.key) ? prev : [...prev, item],
                  )
                  setPicking(false)
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
