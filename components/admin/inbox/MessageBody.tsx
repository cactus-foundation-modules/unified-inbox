'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { LinkPeek, type PeekedLink } from './LinkPeek'
import { hasShownImages, rememberShownImages } from './remote-images'

// An email's own HTML, rendered in a frame of its own (E16).
//
// The markup never touches this page. The frame is loaded from a module route
// that serves the message as a whole document with its own, much stricter
// content policy, and the frame is sandboxed from this side as well: no
// same-origin access, no forms, no navigation - only links, which open in a new
// tab because a sandboxed frame cannot navigate itself anywhere.
//
// The frame reports its own height back, and keeps reporting it as pictures
// arrive and sections are folded away, so a message is exactly as tall as it
// turned out to be rather than a fixed box with a scrollbar inside the page's
// scrollbar. The whole message is on the page and the page scrolls it, which is
// what reading post is. Until that first message arrives the frame stands at a
// sensible height, so a blocked script or a slow load costs a slightly wrong
// size and nothing else.
//
// Two different numbers, and conflating them was the whole of the problem.
//
// OPENING_HEIGHT is what the frame stands at before it has said anything, and
// what it keeps if it never says anything at all. That is the case worth being
// generous about: a message whose frame never reports - a blocked script, an
// extension - used to sit in a 120px letterbox for good.
//
// MIN_HEIGHT is the floor once the frame HAS reported, and it is deliberately
// small. The reported height is the true height, so a two-line "Thanks,
// received" should occupy two lines. Using the opening height as the floor as
// well padded every short reply out to 400px of empty white, which is its own
// kind of wrong in a thread of short replies.
//
// If the height never arrives, something may have gone wrong with the frame -
// or nothing may have, since a browser extension can stop the script that
// reports it. Nothing can be read out of the frame from here to tell the two
// apart, since it deliberately has an origin of its own. So after a few seconds
// of silence the page asks for the same message itself, and only then, and only
// if the answer is a refusal, does it say out loud that the message would not
// open. A blank rectangle with no explanation is the one outcome worth ruling
// out: it reads as an empty message rather than as a message that did not come.

const OPENING_HEIGHT = 400
const MIN_HEIGHT = 60
// A runaway guard and nothing else. It is not a view onto the message, so it is
// not a size anybody has chosen: a newsletter with thirty sections in it is
// twenty thousand pixels tall and every one of them is meant to be read. This
// used to be 4000, which is about two screens, and everything past that could
// only be reached by scrolling inside the message - which is the whole of what
// a frame is not supposed to do.
const MAX_HEIGHT = 200000
/** How long to let the frame stay silent before asking whether it was ever
 *  going to say anything. Long enough for a large message on a slow line. */
const SILENCE_MS = 5000

type Props = {
  messageId: string
  /** Whether this message has any remote pictures parked in it at all. No
   *  button is offered when there is nothing to show. */
  hasRemoteImages: boolean
}

export function MessageBody({ messageId, hasRemoteImages }: Props) {
  const frame = useRef<HTMLIFrameElement | null>(null)
  const [height, setHeight] = useState(OPENING_HEIGHT)
  const [showImages, setShowImages] = useState(false)
  // Whether the record of what has already been shown has been consulted yet.
  // It is read after mount and never during render: the server has no
  // localStorage, so deciding the frame's address from it on the first render
  // is a hydration mismatch on the src. Nothing below is drawn until it has
  // been read, which costs a tick and saves loading the message twice - once
  // without the pictures and again with them.
  const [restored, setRestored] = useState(false)
  // Which message would not open, rather than a plain yes or no: showing the
  // pictures loads a different address, and the answer for one is not the answer
  // for the other. Held this way round so that changing address clears it
  // without a second render to do the clearing.
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  /** The link somebody has just clicked inside the message, waiting to be
   *  looked at. The frame does not follow it - see LinkPeek for why. */
  const [peek, setPeek] = useState<PeekedLink | null>(null)
  const heard = useRef(false)

  const onMessage = useCallback((event: MessageEvent) => {
    // The frame has no origin of its own to check - being sandboxed without
    // same-origin access is the whole point - so identity comes from the window
    // the message arrived from being this frame's.
    if (!frame.current || event.source !== frame.current.contentWindow) return
    const data = event.data as { uinFrameHeight?: unknown; uinLink?: unknown } | null

    const value = data?.uinFrameHeight
    if (typeof value === 'number' && Number.isFinite(value)) {
      heard.current = true
      const applied = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(value)))
      setHeight(applied)
      // Say back how much room it got. The frame puts its own scrollbar away
      // once it knows the whole message is on the page, so a wide table cannot
      // give a message a scrollbar of its own inside the page's.
      frame.current.contentWindow?.postMessage({ uinAppliedHeight: applied }, '*')
      return
    }

    // Everything in here came out of a stranger's email, so it is read as two
    // strings and nothing else - no shape is trusted, no length is assumed.
    const link = data?.uinLink as { href?: unknown; text?: unknown } | undefined
    if (link && typeof link.href === 'string' && link.href !== '') {
      setPeek({
        href: link.href.slice(0, 4000),
        text: typeof link.text === 'string' ? link.text.slice(0, 300) : '',
      })
    }
  }, [])

  useEffect(() => {
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [onMessage])

  // Asked again per message rather than once for the component: the same
  // frame is reused as somebody moves down a thread, and one message having
  // been shown says nothing about the next.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- must read localStorage after mount or the client's first render diverges from the server's HTML
    setShowImages(hasShownImages(messageId))
    setRestored(true)
  }, [messageId])

  const src = `/api/m/unified-inbox/messages/${encodeURIComponent(messageId)}/body${showImages ? '?images=1' : ''}`

  const failed = failedSrc === src

  useEffect(() => {
    if (!restored) return
    heard.current = false
    const stop = new AbortController()
    const timer = setTimeout(() => {
      if (heard.current) return
      fetch(src, { method: 'HEAD', signal: stop.signal })
        .then((response) => { if (!response.ok) setFailedSrc(src) })
        // A request that never came back says nothing either way, and a guess
        // in front of somebody reading their post is worse than no guess.
        .catch(() => {})
    }, SILENCE_MS)
    return () => { clearTimeout(timer); stop.abort() }
  }, [src, restored])

  return (
    <div>
      <LinkPeek link={peek} onClose={() => setPeek(null)} />

      {restored && hasRemoteImages && !showImages && (
        <div
          className="alert alert-info uin-remote-note"
          style={{ marginBottom: '0.5rem', display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}
        >
          <span style={{ flex: '1 1 14rem' }}>
            Pictures in this message have not been loaded. Loading them tells the sender the
            message was opened.
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => { setShowImages(true); rememberShownImages(messageId) }}
          >
            Show pictures
          </button>
        </div>
      )}
      {failed && (
        <div className="alert alert-info" role="alert">
          This message would not open. It may have been cleared out since it arrived. What is
          written about it above still stands.
        </div>
      )}
      {/* Taken off the page rather than hidden: .uin-frame sets display and an
          author rule beats the browser's own for a hidden element. */}
      {restored && !failed && (
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
      )}
    </div>
  )
}
