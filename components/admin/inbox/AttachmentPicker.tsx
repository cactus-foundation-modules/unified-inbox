'use client'

import { useCallback, useState } from 'react'

// A plain list of what is already in the media library.
//
// Deliberately not an upload box: the send path takes an attachment by where it
// already lives in storage, never by bytes in a request, so nothing can be
// talked into emailing an arbitrary file by describing one. Shared by the
// reply composer and the new-message screen, because "attach a file" has to
// mean the same thing in both.

export type Attachment = {
  key: string
  url: string
  filename: string
  contentType: string | null
  sizeBytes: number | null
}

type MediaItem = {
  id: string
  key: string
  url: string
  originalName: string | null
  mimeType: string
  size?: number | null
}

export function AttachmentPicker({ onPick, onClose }: {
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

/** Plain text as safe markup. The server escapes it again on the way into an
 *  internal note; a message goes out as this plus whatever the module adds. */
export function toHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '<br>')
}

/** The chips under the box listing what is going with the message. */
export function AttachmentChips({ attachments, onRemove }: {
  attachments: Attachment[]
  onRemove: (key: string) => void
}) {
  return (
    <>
      {attachments.map((a) => (
        <span key={a.key} className="uin-tag">
          {a.filename}
          <button
            type="button"
            className="btn-link"
            aria-label={`Remove ${a.filename}`}
            onClick={() => onRemove(a.key)}
            style={{ background: 'none', border: 0, cursor: 'pointer', color: 'inherit' }}
          >
            &times;
          </button>
        </span>
      ))}
    </>
  )
}
