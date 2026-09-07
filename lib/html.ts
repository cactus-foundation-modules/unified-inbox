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

/**
 * A stored message, made ready to READ - which is not the same as ready to
 * store, and the difference is where the pictures in our own post went.
 *
 * prepareInboundHtml above runs on the sync path only, so a message that
 * ARRIVED has its remote pictures parked and a message WE SENT does not: the
 * sent copy is recorded as it went out, remote addresses and all, and it has to
 * be - it is what lib/compose.ts quotes under a reply, and a quote with every
 * src stripped out of it is a reply full of holes.
 *
 * The reading frame, though, serves the message under a policy that allows
 * pictures from this origin and nowhere else (see the body route). Deskwell's
 * own pictures live on a media host of their own, so every product photo and
 * the signature logo in anything we had sent was refused by the policy and drew
 * an empty box. Nothing was wrong with the markup and nothing was wrong with the
 * picture; the two halves simply disagreed about who was allowed to fetch it.
 *
 * So the read path parks whatever the write path did not, and then the frame's
 * one route back - the picture proxy - is the route for every picture in every
 * message, ours included. Idempotent by construction: a tag that has already
 * been parked has no src left to park.
 */
export function readableHtml(html: string | null | undefined): string | null {
  // '' stays '' rather than becoming null: the caller can still tell "there was
  // no HTML part" from "the HTML part sanitised away to nothing".
  if (!html) return html ?? null
  return blockRemoteImages(html)
}

// ---------------------------------------------------------------------------
// Pictures that came inside the message.
//
// A signature written in Outlook, a logo on a quote, a screenshot pasted into a
// sentence: none of those are kept on a web server. They arrive as ordinary
// attachments and the markup points at them by their Content-ID header rather
// than by an address - <img src="cid:image001.png@01D9">. Resolving that
// against the parts the message arrived with is what every mail client does,
// and what this module never did, so each one drew an empty box.
//
// Nothing is fetched from anywhere to show one, which is why this is not gated
// behind "Show pictures" the way a remote image is: the bytes are already ours,
// sitting under this module's own key prefix, and there is no sender left to
// learn anything from serving them.
//
// Read path only, like readableHtml above and for the same reason: lib/
// compose.ts quotes the STORED markup under a reply, and a quote whose picture
// addresses have been swapped for this site's own routes is a reply that points
// the recipient at a login page.
// ---------------------------------------------------------------------------

/** Attribute a cid: address is parked on when nothing in the message answers to
 *  it. The tag is left with no src rather than pointing at something no browser
 *  can fetch, so it renders as its alt text instead of a broken picture. */
export const INLINE_SRC_ATTR = 'data-uin-cid'

const IMG_SRC_RE = /<img\b([^>]*?)\ssrc\s*=\s*("([^"]*)"|'([^']*)')/gi

/** True when the markup references a part of the message by Content-ID at all.
 *  Cheap enough to ask of every message so the database is only asked about the
 *  few that have one. */
export function hasInlineImages(html: string | null | undefined): boolean {
  return !!html && /\ssrc\s*=\s*["']\s*cid:/i.test(html)
}

/** The Content-ID each cid: image names, in the order they appear. */
export function inlineImageCids(html: string | null | undefined): string[] {
  if (!html) return []
  const out: string[] = []
  for (const match of html.matchAll(IMG_SRC_RE)) {
    const cid = cidOf(match[3] ?? match[4] ?? '')
    if (cid) out.push(cid)
  }
  return out
}

/**
 * Point every cid: image at the part of the message it names.
 *
 * `hrefFor(cid)` decides the address - the route that serves that part's bytes
 * back - and returns null when nothing in the message answers to that name, in
 * which case the tag loses its src and keeps the name on a data attribute.
 *
 * Idempotent by construction: a tag that has been rewritten no longer has a
 * cid: src to rewrite, and a parked one has no src at all.
 */
export function rewriteInlineImages(html: string, hrefFor: (cid: string) => string | null): string {
  return html.replace(IMG_SRC_RE, (match, before, _quoted, dq, sq) => {
    const cid = cidOf(dq ?? sq ?? '')
    if (!cid) return match
    const href = hrefFor(cid)
    return href
      ? `<img${before} src="${quoteAttr(href)}"`
      : `<img${before} ${INLINE_SRC_ATTR}="${quoteAttr(cid)}"`
  })
}

/** The Content-ID inside a cid: address, or empty for a src that is not one.
 *  Angle brackets are stripped: senders write both `cid:<x@y>` and `cid:x@y`,
 *  and the header they are quoting from carries them. */
function cidOf(src: string): string {
  const value = src.trim()
  if (!/^cid:/i.test(value)) return ''
  return decodeEntities(value.slice(4)).trim().replace(/^<|>$/g, '').trim()
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function quoteAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}
