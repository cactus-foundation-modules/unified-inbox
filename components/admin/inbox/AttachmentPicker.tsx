'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

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
  const [failed, setFailed] = useState(false)
  // Null until somebody has actually asked for something. An empty list before
  // that is not a result, and saying "nothing found" about a search nobody ran
  // is an answer to a question nobody asked.
  const [term, setTerm] = useState<string | null>(null)

  // Every search that comes back is checked against the one being waited for.
  // Two keystrokes in flight at once come back in whichever order storage felt
  // like, and the older one landing last shows the wrong list.
  const request = useRef(0)

  useEffect(() => {
    if (term === null) return
    const mine = ++request.current
    const timer = setTimeout(() => {
      setLoading(true)
      const params = new URLSearchParams({ perPage: '30', folder: 'all' })
      if (term.trim()) params.set('q', term.trim())
      fetch(`/api/admin/media?${params.toString()}`)
        // A refusal is not an empty library. Told apart here, because the two
        // used to arrive on screen as the same sentence and the first of them
        // left somebody hunting for a file that was there all along.
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('refused'))))
        .then((data: { items?: MediaItem[] }) => {
          if (mine !== request.current) return
          setItems(Array.isArray(data.items) ? data.items : [])
          setFailed(false)
        })
        .catch(() => {
          if (mine !== request.current) return
          setItems([])
          setFailed(true)
        })
        .finally(() => { if (mine === request.current) setLoading(false) })
      // Long enough that typing a filename is one search rather than twelve,
      // short enough that the list feels like it is keeping up. The same wait
      // the record picker uses, because they are the same gesture.
    }, term.trim() ? 250 : 0)
    return () => clearTimeout(timer)
  }, [term])

  // Read out of a box rather than off the props, so the listener below can be
  // put on the page once and left there while the composer above re-renders.
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Anything asking a question on top of this owns Escape. The confirm
      // dialog listens on the page in the capture phase as well, and stopping
      // propagation does not silence another listener already on the same node
      // - only stopImmediatePropagation would, and that would have the file
      // list answering for a dialog drawn over it. So it stands down instead,
      // which it can tell by the dialog's own answer button being on the page.
      if (document.querySelector('[data-uin-confirm]')) return
      // Stopped here so shutting the file list does not also shut the message
      // being written behind it, which listens for Escape as it bubbles.
      event.preventDefault()
      event.stopPropagation()
      closeRef.current()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // Both of these say "looking" before the wait below starts, not after it. The
  // search itself is a tick away at the very least, and an empty list drawn in
  // that tick reads as an answer to a question that has not been asked yet -
  // which is the whole complaint this picker was rewritten to settle.
  const ask = useCallback((next: string) => {
    setQuery(next)
    setTerm(next)
    setLoading(true)
  }, [])

  return (
    <div className="card uin-actions">
      <div className="uin-composer-row">
        <label className="sr-only" htmlFor="uin-attach-search">Find a file</label>
        <input
          id="uin-attach-search"
          type="search"
          value={query}
          placeholder="Find a file"
          onChange={(e) => ask(e.target.value)}
          onFocus={() => { if (term === null) { setTerm(''); setLoading(true) } }}
        />
        <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
      </div>

      {failed && (
        <div className="alert alert-danger" role="alert">
          Your files could not be listed. You may not be allowed to see them, or the site did not
          answer. Try again in a moment.
        </div>
      )}
      {loading && <p className="uin-recipients">Looking...</p>}
      {!loading && !failed && term === null && (
        <p className="uin-recipients">Start typing to find a file.</p>
      )}
      {!loading && !failed && term !== null && items.length === 0 && (
        <p className="uin-recipients">
          {query.trim() ? 'Nothing here matches that.' : 'There is nothing in your files yet.'}
        </p>
      )}

      {items.length > 0 && (
        <ul className="uin-ctx-picker">
          {items.map((item) => {
            const filename = item.originalName ?? item.key.split('/').pop() ?? 'attachment'
            return (
              <li key={item.id}>
                <button
                  type="button"
                  // The name is allowed to run out of room and end in an
                  // ellipsis, so one long filename cannot stretch the list; the
                  // whole of it stays on the tooltip and in what is read out.
                  title={filename}
                  aria-label={`Attach ${filename}`}
                  onClick={() => onPick({
                    key: item.key,
                    url: item.url,
                    filename,
                    contentType: item.mimeType ?? null,
                    sizeBytes: item.size ?? null,
                  })}
                >
                  <span className="uin-ctx-main">
                    <span className="uin-chip-clear-text">{filename}</span>
                  </span>
                  <span className="uin-ctx-sub">{describeFile(item.size ?? null, item.mimeType)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/**
 * What came back from the site, but only when it is a sentence somebody wrote
 * for a person to read.
 *
 * The module answers a refused send with English on purpose, and every route
 * that carries one of those sentences forward is written to keep it that way.
 * This is the second lock rather than the first: a route that one day hands
 * back what a mail server said, or a stack trace, or a JSON blob, gets the
 * fallback instead of a place on the screen. Anything with a transport code, a
 * shouted constant, an error class, a line break or a tag in it is not a
 * sentence, and length is its own tell.
 *
 * It lives here with toHtml because these are the small shared bits of writing
 * a message, and both composers need them.
 */
export function plainReason(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  if (!text || text.length > 240) return fallback
  // Markup, line breaks, braces: the shape of something machine-written.
  if (/[\n\r<>{}]/.test(text)) return fallback
  // ECONNREFUSED, EAUTH, SMTP, JSON - shouted constants nobody says out loud.
  if (/\b[A-Z]{4,}\b/.test(text)) return fallback
  // Transport codes, bare or in their long form: 421, 550, 5.7.1.
  if (/\b[45]\d{2}\b/.test(text) || /\b\d\.\d\.\d\b/.test(text)) return fallback
  // Error classes and stack frames.
  if (/(^|\s)(Error|TypeError|RangeError|Exception)\b/.test(text)) return fallback
  if (/\s+at\s+\S+[.(]/.test(text)) return fallback
  if (/\b(code|errno|syscall|hostname|stack|response)\s*[:=]/i.test(text)) return fallback
  return text
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

/** How big it is, in the units a person uses rather than the ones a computer
 *  counts in. Empty when nothing was recorded, so nothing has to say "unknown". */
function formatSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** What sort of thing it is, in a word. The stored type is the machine's name
 *  for it and is nobody else's business. */
function kindOf(mimeType: string | null): string {
  if (!mimeType) return ''
  if (mimeType.startsWith('image/')) return 'Picture'
  if (mimeType.startsWith('video/')) return 'Video'
  if (mimeType.startsWith('audio/')) return 'Sound'
  if (mimeType === 'application/pdf') return 'PDF'
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return 'Spreadsheet'
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return 'Slides'
  if (mimeType.includes('word') || mimeType.includes('document')) return 'Document'
  if (mimeType.startsWith('text/')) return 'Text'
  if (mimeType.includes('zip')) return 'Folder of files'
  return 'File'
}

function describeFile(bytes: number | null, mimeType: string | null): string {
  return [kindOf(mimeType), formatSize(bytes)].filter(Boolean).join(' - ')
}

/** The chips under the box listing what is going with the message. */
export function AttachmentChips({ attachments, onRemove, disabled = false }: {
  attachments: Attachment[]
  onRemove: (key: string) => void
  /** Greyed out while something is in flight, so a file cannot be taken off a
   *  message that is already on its way. */
  disabled?: boolean
}) {
  return (
    <>
      {attachments.map((a) => {
        const size = formatSize(a.sizeBytes)
        return (
          <span
            key={a.key}
            className="uin-tag uin-chip-clear"
            title={size ? `${a.filename} (${size})` : a.filename}
          >
            <span className="uin-chip-clear-text">{a.filename}</span>
            <button
              type="button"
              className="uin-chip-clear-x"
              aria-label={`Take ${a.filename} off this message`}
              disabled={disabled}
              onClick={() => onRemove(a.key)}
              // A cross set in a tag this small is a target about eleven pixels
              // across, which is a miss on a phone. The padding takes it past
              // twenty-four in both directions, and the chip is allowed to grow
              // to fit it: the chip clips what hangs out of it, and a clipped
              // target is not a target - the browser does not hit-test what it
              // did not paint. The row this sits in wraps and centres, so a
              // taller chip costs nothing. Only the right margin is negative,
              // and only into the chip's own padding, where nothing is clipped.
              style={{
                border: 0,
                background: 'none',
                color: 'inherit',
                cursor: disabled ? 'default' : 'pointer',
                // Greyed out the way every other disabled control in here is.
                opacity: disabled ? 0.6 : 1,
                padding: '0.4rem 0.5rem',
                margin: '0 -0.35rem 0 0',
              }}
            >
              &times;
            </button>
          </span>
        )
      })}
    </>
  )
}
