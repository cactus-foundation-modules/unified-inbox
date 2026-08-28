import { sanitizeEmailHtml } from '@/lib/sanitize'

// ---------------------------------------------------------------------------
// Inbound email HTML, made safe enough to keep.
//
// This is arbitrary third-party markup written by anybody who can send an
// email, so it goes through core's own email sanitiser - the same allow-list,
// the same jsdom-backed DOMPurify (pinned at ^26 for a reason; do not swap it
// for anything else). Nothing here trusts the sender.
//
// Two things happen after that, both about what the message can see and do once
// somebody opens it:
//
//   Remote images are defused rather than removed. A tracking pixel tells the
//   sender the moment the mail was read, by whom and from where, and a spammer
//   learns the address is live. The original address is kept on a data
//   attribute so the reader can choose to show images, which is what every
//   grown-up mail client does.
//
//   The markup is still not rendered inline anywhere. The thread view puts it in
//   a sandboxed iframe, because email HTML carries its own CSS and will
//   eventually try to lay out the entire admin (E16).
// ---------------------------------------------------------------------------

/** Attribute the original image address is parked on when images are blocked. */
export const REMOTE_SRC_ATTR = 'data-uin-remote-src'

/** True when the value points somewhere off the page rather than at an
 *  attachment embedded in the message itself. */
function isRemote(url: string): boolean {
  return /^(https?:)?\/\//i.test(url.trim())
}

/**
 * Park every remote image address on a data attribute and leave the tag with no
 * src, so opening a message fetches nothing from the sender's server until the
 * reader asks for it.
 */
export function blockRemoteImages(html: string): string {
  return html
    .replace(/<img\b([^>]*?)\ssrc\s*=\s*("([^"]*)"|'([^']*)')/gi, (match, before, _quoted, dq, sq) => {
      const url = dq ?? sq ?? ''
      if (!isRemote(url)) return match
      return `<img${before} ${REMOTE_SRC_ATTR}="${url.replace(/"/g, '&quot;')}"`
    })
    .replace(/\sbackground\s*=\s*("([^"]*)"|'([^']*)')/gi, (match, _quoted, dq, sq) => {
      const url = dq ?? sq ?? ''
      return isRemote(url) ? '' : match
    })
}

/**
 * What gets stored in body_html: sanitised, with remote images defused. Empty
 * string rather than null for markup that sanitises down to nothing, so the
 * caller can tell "there was no HTML part" from "the HTML part was all script".
 */
export function prepareInboundHtml(html: string | null | undefined): string | null {
  if (!html) return null
  const clean = sanitizeEmailHtml(html)
  if (!clean.trim()) return ''
  return blockRemoteImages(clean)
}

/** Plain text for a message that arrived as HTML only, so the list preview and
 *  any future search have something to read that is not markup. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li|table|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
