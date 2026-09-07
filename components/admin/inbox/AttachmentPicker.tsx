'use client'

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import { MAX_DROPPED_BYTES, describeBytes } from '@/modules/unified-inbox/lib/uploads'
import { AttachmentDropNotice, AttachmentDropOverlay } from './AttachmentDropChrome'
import type { AttachmentDrop } from './useAttachmentDrop'
import { CloseIcon, PaperclipIcon } from './icons'

// Putting files on a message.
//
// A dialog rather than a panel that unfolds under the writing. The panel had
// room for a search box and a short list and nothing else, which quietly made
// "attach a file" mean "attach a file that is already in the media library" -
// and the far more ordinary errand, the quote sitting on somebody's desktop,
// had no button at all. It could be dragged onto the message, and that is all,
// which is a gesture nobody discovers by looking.
//
// So: a big box that says drop them here with a button that opens the file
// chooser, and the search over the library kept above it for the other case.
// Typing in the search puts the results where the big box was; clearing it puts
// the big box back. Nothing shuts after a pick - attaching six things is one
// errand, and a dialog that closed itself after the first would be five more
// trips.
//
// SENDING IS UNCHANGED. A file chosen here is either already in storage or is
// put there first by the uploads route; either way what reaches the composer is
// a reference to where it lives. The send path still takes an attachment by its
// place in storage and never by bytes in a send request, so nothing can be
// talked into emailing an arbitrary file by describing one.
//
// The QUEUE is the composer's, not this dialog's. It is handed down as `drop`
// rather than started here on purpose: a file still going up when somebody
// presses Done must carry on going up, and a hook that lives in this component
// would be torn down - and every upload with it - the moment the dialog closed.

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

export function AttachmentPicker({ drop, attached, onPick, onClose }: {
  /** The composer's upload queue, so anything started here outlives the dialog. */
  drop: AttachmentDrop
  /** What is already on the message: the count at the foot, and the reason a
   *  library file that is already on it is offered greyed out rather than
   *  offered again. */
  attached: Attachment[]
  onPick: (item: Attachment) => void
  onClose: () => void
}) {
  const [items, setItems] = useState<MediaItem[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  // Every search that comes back is checked against the one being waited for.
  // Two keystrokes in flight at once come back in whichever order storage felt
  // like, and the older one landing last shows the wrong list.
  const request = useRef(0)

  const fileInput = useRef<HTMLInputElement | null>(null)
  const search = useRef<HTMLInputElement | null>(null)
  const returnTo = useRef<HTMLElement | null>(null)

  /** Which half of the dialog is showing. An empty box is not a search, so it
   *  gets the big drop box back rather than a list of everything. */
  const searching = query.trim().length > 0
  const already = new Set(attached.map((a) => a.key))

  /** Typing in the search box, and the only thing that changes which half of
   *  the dialog is showing.
   *
   *  Everything a keystroke settles is settled here rather than in the effect
   *  below: "looking" is said BEFORE the wait starts, because the search
   *  is a tick away at the very least and an empty list drawn in that tick
   *  reads as an answer to a question nobody has asked yet. Emptying the box
   *  disowns whatever is in flight, so a slow search finishing afterwards
   *  cannot draw a list over the drop box that has just come back. */
  const ask = useCallback((next: string) => {
    setQuery(next)
    if (next.trim()) {
      setLoading(true)
      return
    }
    request.current += 1
    setItems([])
    setLoading(false)
    setFailed(false)
  }, [])

  useEffect(() => {
    const term = query.trim()
    if (!term) return
    const mine = ++request.current
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ perPage: '30', folder: 'all', q: term })
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
    }, 250)
    return () => clearTimeout(timer)
  }, [query])

  // Read out of a box rather than off the props, so the listener below can be
  // put on the page once and left there while the composer above re-renders.
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose })

  // The keyboard starts in the search box and goes back where it came from.
  useEffect(() => {
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    search.current?.focus()
    return () => { returnTo.current?.focus() }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Anything asking a question on top of this owns Escape. The confirm
      // dialog listens on the page in the capture phase as well, and stopping
      // propagation does not silence another listener already on the same node
      // - only stopImmediatePropagation would, and that would have the file
      // dialog answering for a question drawn over it. So it stands down
      // instead, which it can tell by the dialog's own answer button being on
      // the page.
      if (document.querySelector('[data-uin-confirm]')) return
      // Stopped here so shutting the file dialog does not also shut the message
      // being written behind it, which listens for Escape as it bubbles.
      event.preventDefault()
      event.stopPropagation()
      closeRef.current()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])

  /** Files off the chooser. The value is cleared afterwards so choosing the
   *  same file twice in a row is two goes rather than one and then nothing. */
  const onChosen = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const list = event.target.files
    if (list && list.length > 0) drop.addFiles(Array.from(list))
    event.target.value = ''
  }, [drop])

  // Drawn into the page itself rather than where it is written: the composer
  // sits in a pane that scrolls its own contents, and a dialog inside one of
  // those is a dialog clipped by it. The catalogue picker is drawn the same way
  // for the same reason.
  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className="uin-modal"
      // Only the background itself, not something inside the card that happened
      // to finish its drag out here.
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div
        className="uin-modal-card uin-modal-card-attach uin-droppable"
        role="dialog"
        aria-modal="true"
        aria-label="Attach files to this message"
        // The whole card, not just the box inside it: somebody dragging a quote
        // at this dialog is aiming at the dialog, and asking them to hit a
        // particular rectangle inside it is asking them to aim twice.
        {...drop.dropProps}
      >
        <AttachmentDropOverlay dragging={drop.dragging} />

        <div className="uin-modal-head">
          <h2 className="uin-modal-title">Attach files</h2>
          <button
            type="button"
            className="uin-modal-close"
            aria-label="Close"
            title="Close"
            onClick={onClose}
          >
            {CloseIcon}
          </button>
        </div>

        <div className="uin-modal-body">
          <div className="uin-composer-row uin-attach-find">
            <label className="sr-only" htmlFor="uin-attach-search">Find a file already in your files</label>
            <input
              id="uin-attach-search"
              ref={search}
              type="search"
              value={query}
              placeholder="Find a file already in your files"
              onChange={(e) => ask(e.target.value)}
            />
          </div>

          {searching ? (
            <>
              {failed && (
                <div className="alert alert-danger" role="alert">
                  Your files could not be listed. You may not be allowed to see them, or the site did
                  not answer. Try again in a moment.
                </div>
              )}
              {loading && <p className="uin-recipients">Looking...</p>}
              {!loading && !failed && items.length === 0 && (
                <p className="uin-recipients">Nothing here matches that.</p>
              )}
              {!loading && items.length > 0 && (
                <ul className="uin-ctx-picker uin-attach-results">
                  {items.map((item) => {
                    const filename = item.originalName ?? item.key.split('/').pop() ?? 'attachment'
                    const on = already.has(item.key)
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          // The name is allowed to run out of room and end in an
                          // ellipsis, so one long filename cannot stretch the
                          // list; the whole of it stays on the tooltip and in
                          // what is read out.
                          title={filename}
                          aria-label={on ? `${filename} is already attached` : `Attach ${filename}`}
                          disabled={on}
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
                          <span className="uin-ctx-sub">
                            {on ? 'Already on this message' : describeFile(item.size ?? null, item.mimeType)}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </>
          ) : (
            <div className="uin-dropzone">
              <span className="uin-dropzone-icon" aria-hidden="true">{PaperclipIcon}</span>
              <p className="uin-dropzone-title">Drag your files here</p>
              <p className="uin-dropzone-sub">As many as you like, all at once.</p>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => fileInput.current?.click()}
              >
                Choose files
              </button>
              <input
                ref={fileInput}
                type="file"
                multiple
                className="sr-only"
                // Hidden, and out of the way of the keyboard as well: the button
                // above is what anybody is meant to reach, and a second stop on
                // the same thing is a stop that appears to do nothing.
                tabIndex={-1}
                aria-hidden="true"
                onChange={onChosen}
              />
              <p className="uin-dropzone-note">
                Up to {describeBytes(MAX_DROPPED_BYTES)} each. Anything bigger, put it in your files
                first and then search for it above.
              </p>
            </div>
          )}

          <AttachmentDropNotice
            progress={drop.progress}
            errors={drop.errors}
            dismissErrors={drop.dismissErrors}
          />
        </div>

        <div className="uin-modal-foot">
          <span className="uin-recipients uin-modal-foot-note">{countAttached(attached.length)}</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** What the foot of the dialog says. Counted out in words at the low numbers,
 *  because "1 files" is the sort of thing that makes a site look unfinished. */
function countAttached(count: number): string {
  if (count === 0) return 'Nothing attached yet.'
  if (count === 1) return 'One file on this message.'
  return `${count} files on this message.`
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
