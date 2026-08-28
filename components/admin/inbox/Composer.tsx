'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

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

type Attachment = { key: string; url: string; filename: string; contentType: string | null; sizeBytes: number | null }

type MediaItem = { id: string; key: string; url: string; originalName: string | null; mimeType: string; size?: number | null }

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

/** Plain text as safe markup. The server escapes it again on the way into an
 *  internal note; a reply goes out as this plus whatever the module adds. */
function toHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '<br>')
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
          {attachments.map((a) => (
            <span key={a.key} className="uin-tag">
              {a.filename}
              <button
                type="button"
                className="btn-link"
                aria-label={`Remove ${a.filename}`}
                onClick={() => setAttachments((prev) => prev.filter((p) => p.key !== a.key))}
                style={{ background: 'none', border: 0, cursor: 'pointer', color: 'inherit' }}
              >
                &times;
              </button>
            </span>
          ))}
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

/** A plain list of what is already in the media library. Deliberately not an
 *  upload box: the send path takes an attachment by where it already lives in
 *  storage, never by bytes in a request, so nothing can be talked into emailing
 *  an arbitrary file by describing one. */
function AttachmentPicker({ onPick, onClose }: {
  onPick: (item: Attachment) => void
  onClose: () => void
}) {
  const [items, setItems] = useState<MediaItem[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)

  const search = useCallback(async (q: string) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ perPage: '30', folder: 'all' })
      if (q.trim()) params.set('q', q.trim())
      const response = await fetch(`/api/admin/media?${params.toString()}`)
      const data = await response.json().catch(() => null)
      setItems(data?.items ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  return (
    <div className="card" style={{ display: 'grid', gap: '0.5rem' }}>
      <div className="uin-composer-row">
        <input
          type="search"
          value={query}
          placeholder="Find a file"
          onChange={(e) => { setQuery(e.target.value); void search(e.target.value) }}
          onFocus={() => { if (items.length === 0) void search('') }}
        />
        <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
      </div>
      {loading && <p className="uin-recipients">Looking...</p>}
      {!loading && items.length === 0 && <p className="uin-recipients">Nothing found yet.</p>}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.25rem' }}>
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="uin-chip"
              onClick={() => onPick({
                key: item.key,
                url: item.url,
                filename: item.originalName ?? item.key.split('/').pop() ?? 'attachment',
                contentType: item.mimeType ?? null,
                sizeBytes: item.size ?? null,
              })}
            >
              {item.originalName ?? item.key}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
