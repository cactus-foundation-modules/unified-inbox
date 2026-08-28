import { quotedHtmlIndex } from './list'

// ---------------------------------------------------------------------------
// The document an email's own HTML is rendered inside (E16).
//
// Email markup is arbitrary third-party HTML written by anybody who can send a
// message, and it carries its own CSS - table layouts, absolute widths, and
// often a stylesheet that expects to own the whole page. Dropped into the admin
// it will eventually lay out the admin, so it never goes anywhere near it. It
// goes in a frame of its own, served from this route with its own content
// policy, and the frame is sandboxed from the outside as well.
//
// The frame is loaded from a URL rather than written into a srcdoc attribute,
// which matters more than it looks: a document loaded from a URL carries its
// OWN policy headers, while a srcdoc frame inherits the parent page's. Serving
// it means the message can be locked down harder than the admin around it, and
// relative addresses inside it resolve against this module's own routes.
//
// The message is rendered on a light surface in both themes. That is a
// decision, not an oversight: the sender chose their own colours on the
// assumption of a white page, and repainting their background dark while
// leaving their text colours alone is how a message ends up black on black. The
// chrome around the frame follows the theme; the message inside it is shown as
// it was sent.
// ---------------------------------------------------------------------------

/** Styles for the frame. Deliberately gentle - anything stronger would be this
 *  module overruling the sender about what their message looks like. */
const FRAME_STYLES = `
  html, body { margin: 0; padding: 0; }
  body {
    background: #ffffff;
    color: #1a1a1a;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 0.9375rem;
    line-height: 1.55;
    padding: 0.25rem 0.125rem;
    overflow-wrap: break-word;
    word-break: break-word;
  }
  img, video { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  a { color: #14532d; }
  pre { white-space: pre-wrap; }
  details.uin-quote { margin-top: 1rem; }
  details.uin-quote > summary {
    cursor: pointer;
    display: inline-block;
    padding: 0.15rem 0.5rem;
    border: 1px solid #d6d1c8;
    border-radius: 999px;
    background: #f5f3ef;
    color: #4a4540;
    font-size: 0.75rem;
    list-style: none;
  }
  details.uin-quote > summary::-webkit-details-marker { display: none; }
  details.uin-quote > summary:focus-visible { outline: 2px solid #14532d; outline-offset: 2px; }
  details.uin-quote > div { margin-top: 0.75rem; border-left: 3px solid #e2ded7; padding-left: 0.75rem; }
`

/** Tells the page around it how tall the message turned out to be, so the frame
 *  can be exactly its own height instead of a fixed box with a scrollbar inside
 *  a scrollbar. It is the only script in the document and it carries a nonce,
 *  so anything that somehow survived the sanitiser still cannot run. */
function resizeScript(nonce: string): string {
  return `<script nonce="${nonce}">(function(){
  function send(){
    var h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    parent.postMessage({ uinFrameHeight: h }, '*');
  }
  window.addEventListener('load', send);
  window.addEventListener('resize', send);
  document.addEventListener('toggle', send, true);
  setTimeout(send, 60);
  setTimeout(send, 400);
})();</script>`
}

/**
 * Every link in a message opens in a new tab, and takes nothing with it.
 *
 * The frame is sandboxed, so a link that tried to navigate in place would
 * simply do nothing at all and read as a broken message. `noopener` and
 * `noreferrer` mean the page that opens learns neither where it came from nor
 * how to reach back - a link in a stranger's email has no business with either.
 */
export function openLinksInNewTab(html: string): string {
  return html.replace(/<a\b([^>]*)>/gi, (match, attrs: string) => {
    if (!/\shref\s*=/i.test(attrs)) return match
    let out = attrs
    if (!/\starget\s*=/i.test(out)) out += ' target="_blank"'
    if (!/\srel\s*=/i.test(out)) out += ' rel="noopener noreferrer"'
    return `<a${out}>`
  })
}

export type MessageDocumentOptions = {
  html: string
  nonce: string
  /** Where the quoted history is folded away behind a toggle. Off for a
   *  forwarded message the reader opened deliberately. */
  collapseQuoted?: boolean
}

/** Wrap the message's own markup in a whole document, quoted history folded. */
export function buildMessageDocument({ html, nonce, collapseQuoted = true }: MessageDocumentOptions): string {
  let content = openLinksInNewTab(html)
  if (collapseQuoted) {
    const at = quotedHtmlIndex(content)
    if (at > 0) {
      content =
        `${content.slice(0, at)}<details class="uin-quote">` +
        `<summary>Show the earlier messages</summary><div>${content.slice(at)}</div></details>`
    }
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${FRAME_STYLES}</style></head>
<body>${content}${resizeScript(nonce)}</body></html>`
}

/**
 * The frame's own content policy: nothing loads from anywhere, except pictures
 * from this site (which is where the picture proxy serves them from) and the
 * one script carrying this nonce. No fetching, no forms, no frames of its own,
 * and nothing may frame it but this site.
 */
export function messageDocumentCsp(nonce: string): string {
  return [
    `default-src 'none'`,
    `img-src 'self' data:`,
    `style-src 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src data:`,
    `form-action 'none'`,
    `base-uri 'none'`,
    `frame-ancestors 'self'`,
  ].join('; ')
}
