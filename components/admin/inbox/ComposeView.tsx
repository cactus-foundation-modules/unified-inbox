'use client'

import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { inboxHref } from '@/modules/unified-inbox/lib/list'
import { AttachmentChips, AttachmentPicker, toHtml, type Attachment } from './AttachmentPicker'
import { BackIcon } from './icons'

// Writing a brand new message, rather than answering one somebody else started.
//
// It takes the same place on the screen as a conversation, because that is the
// place this screen puts one conversation's worth of writing - and once it has
// gone, what you are looking at IS a conversation, so the browser is sent
// straight to it.
//
// The address it goes out as is a menu rather than a fixed value. It opens on
// whichever inbox the rail is showing, which is what somebody means by "write a
// new one" from inside accounts@, but a note to a supplier that ought to come
// from marcus@ is one click away rather than a trip through the settings. Only
// inboxes this person may actually send from are in the menu: offering an
// address the send route would then refuse is a worse answer than not offering
// it (D16).

export type ComposeInbox = { id: string; name: string; address: string }

type Props = {
  base: string
  params: Record<string, string>
  inboxes: ComposeInbox[]
  /** Which one the menu opens on, worked out on the server from the rail. */
  defaultInboxId: string | null
}

function splitAddresses(value: string): string[] {
  return value.split(/[,;]/).map((a) => a.trim()).filter(Boolean)
}

export function ComposeView({ base, params, inboxes, defaultInboxId }: Props) {
  const router = useRouter()
  const [inboxId, setInboxId] = useState(defaultInboxId ?? '')
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [showCc, setShowCc] = useState(false)
  const [subject, setSubject] = useState('')
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // One token per screenful, exactly as the reply composer carries: a double
  // press, or a retry after a timeout that may or may not have arrived, is one
  // email rather than two (E14). Nothing regenerates it here, because a message
  // that has genuinely gone leaves this screen altogether.
  const token = useRef(crypto.randomUUID())

  const closeHref = inboxHref(base, params, {})
  const chosen = inboxes.find((i) => i.id === inboxId) ?? null

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
        }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        setError(data?.error ?? 'That message could not be sent.')
        return
      }
      // It is a conversation now, so go and stand in it - and in the inbox it
      // was filed into, which is not necessarily the one the rail was showing
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
  }, [attachments, base, cc, inboxId, params, router, subject, text, to])

  return (
    <div className="uin-thread">
      <div className="uin-thread-head">
        <a className="uin-chip" href={closeHref} style={{ justifySelf: 'start' }}>
          {BackIcon} Back to the list
        </a>
        <h2 className="uin-thread-subject">A new message</h2>
      </div>

      <div className="uin-composer">
        <div className="field">
          <label htmlFor="uin-new-from">From</label>
          <select
            id="uin-new-from"
            value={inboxId}
            onChange={(e) => { setInboxId(e.target.value); setError('') }}
          >
            {inboxes.map((inbox) => (
              <option key={inbox.id} value={inbox.id}>
                {inbox.name} ({inbox.address})
              </option>
            ))}
          </select>
          {chosen && (
            <p className="uin-recipients">
              They will see it come from {chosen.address}, and their reply lands back in {chosen.name}.
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="uin-new-to">To</label>
          <input
            id="uin-new-to"
            type="text"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="name@example.com"
            autoComplete="off"
          />
          <p className="uin-recipients">Separate several addresses with a comma.</p>
        </div>

        {showCc ? (
          <div className="field">
            <label htmlFor="uin-new-cc">Cc</label>
            <input
              id="uin-new-cc"
              type="text"
              value={cc}
              onChange={(e) => setCc(e.target.value)}
              placeholder="somebody.else@example.com"
              autoComplete="off"
            />
          </div>
        ) : (
          <div className="uin-composer-row">
            <button type="button" className="uin-chip" onClick={() => setShowCc(true)}>
              Add a Cc
            </button>
          </div>
        )}

        <div className="field">
          <label htmlFor="uin-new-subject">Subject</label>
          <input
            id="uin-new-subject"
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="What it is about"
            autoComplete="off"
          />
        </div>

        <div className="field">
          <label htmlFor="uin-new-text">Your message</label>
          <textarea
            id="uin-new-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
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

        <div className="uin-composer-row">
          <button type="button" className="btn btn-primary btn-sm" onClick={submit} disabled={busy}>
            {busy ? 'Sending...' : 'Send'}
          </button>
          <a className="uin-chip" href={closeHref}>Cancel</a>
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
  )
}
