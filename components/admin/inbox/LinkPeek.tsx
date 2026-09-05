'use client'

import { useEffect, useState } from 'react'

// ---------------------------------------------------------------------------
// Where a link in somebody else's email actually goes.
//
// A link in a message is a link a stranger wrote, and so are the words on it.
// "View your invoice" over an address in another country is not an edge case,
// it is the entire mechanism of every phishing email ever sent - and a mail
// client that follows the click without showing the address is a mail client
// helping. So a click opens this instead: the whole address, the host on its
// own line because that is the part that decides, and the reader choosing.
//
// Only http, https and mailto are ever offered. The sanitiser takes javascript:
// and data: out long before anything reaches here, and this is the second lock
// on that door: an address in a scheme this does not know is shown and not
// opened, so the worst a survivor can manage is being read.
// ---------------------------------------------------------------------------

export type PeekedLink = {
  /** The absolute address the browser would have gone to. */
  href: string
  /** What the link said, when that is not simply the address again. The gap
   *  between the two is the thing worth looking at. */
  text: string
}

const OPENABLE = new Set(['http:', 'https:', 'mailto:'])

export function LinkPeek({ link, onClose }: { link: PeekedLink | null; onClose: () => void }) {
  // Which address was copied rather than whether one was, so opening the panel
  // on a different link shows "Copy" again without an effect to reset it.
  const [copiedHref, setCopiedHref] = useState<string | null>(null)

  useEffect(() => {
    if (!link) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [link, onClose])

  if (!link) return null

  const parsed = safeUrl(link.href)
  const openable = parsed !== null && OPENABLE.has(parsed.protocol)
  // A mailto has no host worth printing, and printing "" reads as a bug.
  const host = parsed && parsed.protocol !== 'mailto:' ? parsed.host : null
  const saidSomethingElse = link.text !== '' && link.text !== link.href && link.text !== stripSlash(link.href)

  const open = () => {
    if (!openable) return
    window.open(link.href, '_blank', 'noopener,noreferrer')
    onClose()
  }

  const copy = () => {
    void navigator.clipboard?.writeText(link.href).then(() => setCopiedHref(link.href)).catch(() => {})
  }

  return (
    <div
      className="uin-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Where this link goes"
      // Only a press that both starts and ends on the backdrop closes it, so a
      // drag that began on the address and ended outside does not.
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className="uin-modal-card uin-peek">
        <div className="uin-modal-head">
          <strong>Where this link goes</strong>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
        </div>

        <div className="uin-modal-body">
          {host && (
            <div className="uin-peek-host">
              <span className="uin-camp-hint">It goes to</span>
              <b>{host}</b>
            </div>
          )}

          {saidSomethingElse && (
            <div className="uin-peek-said">
              <span className="uin-camp-hint">The link said</span>
              <span>{link.text}</span>
            </div>
          )}

          <div className="uin-camp-hint">The whole address, exactly as it was written:</div>
          <code className="uin-peek-url">{link.href}</code>

          {!openable && (
            <div className="alert alert-danger" role="alert">
              This is not an ordinary web address, so it will not be opened from here. Nothing about
              that is normal in an email, and it is worth being suspicious of.
            </div>
          )}
          {openable && (
            <p className="uin-camp-hint" style={{ margin: 0 }}>
              Nothing has been opened yet. Check the address reads the way you would expect from
              whoever sent it - the part before the first single slash is the one that decides where
              you end up.
            </p>
          )}
        </div>

        <div className="uin-modal-foot">
          <button type="button" className="btn btn-secondary btn-sm" onClick={copy}>
            {copiedHref === link.href ? 'Copied' : 'Copy the address'}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
          {openable && (
            <button type="button" className="btn btn-primary btn-sm" onClick={open}>
              Open in a new tab
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** The address as the browser reads it, or null when it is not one at all.
 *  Never throws: this is handed whatever a stranger put in an href. */
function safeUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/** "https://example.co.uk/" and "https://example.co.uk" are the same address
 *  said two ways, and only one of them is what the link had written on it. */
function stripSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}
