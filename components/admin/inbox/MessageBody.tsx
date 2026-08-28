'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

// An email's own HTML, rendered in a frame of its own (E16).
//
// The markup never touches this page. The frame is loaded from a module route
// that serves the message as a whole document with its own, much stricter
// content policy, and the frame is sandboxed from this side as well: no
// same-origin access, no forms, no navigation - only links, which open in a new
// tab because a sandboxed frame cannot navigate itself anywhere.
//
// The frame reports its own height back, so a message is exactly as tall as it
// turned out to be rather than a fixed box with a scrollbar inside the page's
// scrollbar. Until that message arrives it stands at a sensible height, so a
// blocked script or a slow load costs a slightly wrong size and nothing else.

const MIN_HEIGHT = 120
const MAX_HEIGHT = 4000

type Props = {
  messageId: string
  /** Whether this message has any remote pictures parked in it at all. No
   *  button is offered when there is nothing to show. */
  hasRemoteImages: boolean
}

export function MessageBody({ messageId, hasRemoteImages }: Props) {
  const frame = useRef<HTMLIFrameElement | null>(null)
  const [height, setHeight] = useState(MIN_HEIGHT)
  const [showImages, setShowImages] = useState(false)

  const onMessage = useCallback((event: MessageEvent) => {
    // The frame has no origin of its own to check - being sandboxed without
    // same-origin access is the whole point - so identity comes from the window
    // the message arrived from being this frame's.
    if (!frame.current || event.source !== frame.current.contentWindow) return
    const value = (event.data as { uinFrameHeight?: unknown } | null)?.uinFrameHeight
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(value))))
  }, [])

  useEffect(() => {
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [onMessage])

  const src = `/api/m/unified-inbox/messages/${encodeURIComponent(messageId)}/body${showImages ? '?images=1' : ''}`

  return (
    <div>
      {hasRemoteImages && !showImages && (
        <div
          className="alert alert-info"
          style={{ marginBottom: '0.5rem', display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}
        >
          <span style={{ flex: '1 1 14rem' }}>
            Pictures in this message have not been loaded. Loading them tells the sender the
            message was opened.
          </span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowImages(true)}>
            Show pictures
          </button>
        </div>
      )}
      <iframe
        ref={frame}
        className="uin-frame"
        style={{ height: `${height}px` }}
        src={src}
        title="Message"
        // No allow-same-origin: the frame gets an origin of its own, so nothing
        // in a stranger's email can reach this page, its cookies or its storage.
        // Scripts are allowed only so the one script the route puts there can
        // report the height back, and it carries a nonce nothing else has.
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
      />
    </div>
  )
}
