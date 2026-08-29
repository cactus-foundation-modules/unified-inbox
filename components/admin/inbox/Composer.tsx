'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AttachmentChips, AttachmentPicker, toHtml, type Attachment } from './AttachmentPicker'

// The composer: reply, reply to everybody, forward, and an internal note.
//
// Almost nothing about a message is decided here. The signature, the quoted
// original, the Message-ID, the References chain and who a reply actually goes
// to all live in the module's own pure code on the server, where they are
// tested - this is a box to type in and a button to press. Sending the same
// thing twice is the one thing the browser has to help with, and it does it by
// carrying a token.

type Mode = 'reply' | 'reply-all' | 'forward' | 'note'

type StaffMember = { id: string; name: string }

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
}

export function Composer({
  threadId, replyTo, replyAllTo, canReply, canForward, staff, cannotReplyReason,
}: Props) {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>(canReply ? 'reply' : 'note')
  const [text, setText] = useState('')
  const [forwardTo, setForwardTo] = useState('')
  const [mentions, setMentions] = useState<string[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [picking, setPicking] = useState(false)

  // One token per composer session, deliberately NOT regenerated per click: it
  // is what makes a double press, or a retry after a timeout that may or may not
  // have arrived, one message rather than two. It changes when a message has
  // genuinely been sent and the box is empty again.
  const token = useRef(crypto.randomUUID())

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

  const submit = useCallback(async () => {
    if (!text.trim()) {
      setError('There is nothing to send yet.')
      return
    }
    setBusy(true)
    setError('')
    try {
      if (mode === 'note') {
        const response = await fetch(`/api/m/unified-inbox/threads/${threadId}/notes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, mentions }),
        })
        if (!response.ok) {
          setError((await response.json().catch(() => null))?.error ?? 'That note could not be saved.')
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
          }),
        })
        if (!response.ok) {
          setError((await response.json().catch(() => null))?.error ?? 'That message could not be sent.')
          return
        }
      }
      setText('')
      setForwardTo('')
      setAttachments([])
      setMentions([])
      token.current = crypto.randomUUID()
      router.refresh()
    } catch {
      setError('The site could not be reached. Nothing was sent.')
    } finally {
      setBusy(false)
    }
  }, [attachments, forwardTo, mentions, mode, router, text, threadId])

  const recipients = mode === 'reply' ? replyTo : mode === 'reply-all' ? replyAllTo : []

  return (
    <div className="uin-composer">
      <div className="uin-composer-modes" role="group" aria-label="What to send">
        {modes.map((m) => (
          <button
            key={m.id}
            type="button"
            className="uin-chip"
            aria-pressed={mode === m.id}
            onClick={() => { setMode(m.id); setError('') }}
          >
            {m.label}
          </button>
        ))}
      </div>

      {cannotReplyReason && mode !== 'note' && (
        <div className="alert alert-info">{cannotReplyReason}</div>
      )}

      {mode === 'forward' ? (
        <div className="field">
          <label htmlFor="uin-forward-to">Forward to</label>
          <input
            id="uin-forward-to"
            type="text"
            value={forwardTo}
            onChange={(e) => setForwardTo(e.target.value)}
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
          onChange={(e) => setText(e.target.value)}
          placeholder={mode === 'note' ? 'Something for the others to see' : 'Write your reply'}
        />
      </div>

      {mode === 'note' && staff.length > 0 && (
        <div className="uin-composer-row">
          <span className="uin-recipients">Let somebody know</span>
          {staff.map((person) => (
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
        </div>
      )}

      {mode !== 'note' && (
        <div className="uin-composer-row">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPicking(true)}>
            Attach a file
          </button>
          <AttachmentChips
            attachments={attachments}
            onRemove={(key) => setAttachments((prev) => prev.filter((p) => p.key !== key))}
          />
        </div>
      )}

      {error && <div className="alert alert-danger">{error}</div>}

      <div className="uin-composer-row">
        <button type="button" className="btn btn-primary btn-sm" onClick={submit} disabled={busy}>
          {busy ? 'Sending...' : mode === 'note' ? 'Save note' : 'Send'}
        </button>
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
  )
}
