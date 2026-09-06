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
  /* The message, and the box holding it to the width there is.
     Email is written for a column about 600px wide and a good deal of it says
     so in pixels, so in a narrower reading pane the message is wider than the
     frame it is in. That used to earn it a scrollbar along the bottom, which is
     a frame behaving like a frame: the reader asked for the message, not for a
     window onto part of it. It is scaled down to fit instead, the way a phone
     shows a desktop-width email, and the box round it is made exactly as tall
     as the message ended up. A message that already fits is not touched. */
  #uin-fit { overflow: hidden; }
  #uin-doc { transform-origin: 0 0; }
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

/**
 * The frame's one script. It carries a nonce nothing else has, so anything that
 * somehow survived the sanitiser still cannot run. Three jobs.
 *
 * HOW WIDE THE MESSAGE WANTS TO BE, and shrinking it until it fits. See
 * fitToWidth below - this is the one that stops a frame having a scrollbar of
 * its own along the bottom.
 *
 * HOW TALL IT TURNED OUT TO BE, so the frame is exactly its own height instead
 * of a fixed box with a scrollbar inside a scrollbar.
 *
 * WHERE A LINK ACTUALLY GOES. Every link in a stranger's email is a link
 * somebody else wrote, and the words on it are theirs too - "your invoice" over
 * a web address in another country is the whole of how phishing works. So a
 * click does not follow the link: it hands the address back to the page around
 * the frame, which puts it on screen in full and lets the reader decide. The
 * DOM's own `href` property is read rather than the attribute, because that is
 * the absolute address the browser would actually visit.
 *
 * The markup still carries target="_blank" underneath. If this script never
 * runs - a blocked script, an extension - a link that does nothing at all is a
 * message that reads as broken, and a working link is better than a dead one.
 */
function frameScript(nonce: string): string {
  return `<script nonce="${nonce}">(function(){
  var doc = document.documentElement;
  // Ours, and first in the body, so an email carrying an id of the same name
  // cannot be picked up instead: getElementById answers in document order.
  var fit = document.getElementById('uin-fit');
  var page = fit ? fit.firstElementChild : null;
  var last = 0;
  var sent = 0;
  var pending = false;

  // Shrink a message that is wider than the frame until the whole of it fits.
  //
  // Almost every marketing email is a table with a width in pixels on it, and
  // in a reading pane narrower than that width the message hangs off the side.
  // The alternative to shrinking it is a sideways scrollbar, which shows the
  // reader the left-hand half of a message and hides the rest behind a gesture
  // nobody makes. So it is scaled, which is what a phone does with the same
  // mail and for the same reason.
  //
  // Everything is put back before measuring: the natural width has to be read
  // with no scale on it, or each pass would measure the last pass's answer and
  // walk the message steadily smaller. The box is then given the scaled height,
  // because a transform moves what is drawn and not what is laid out - without
  // it the document stays as tall as the message was BEFORE it shrank, and the
  // frame ends with a band of white under the message the size of what was
  // taken off.
  function fitToWidth(){
    if (!fit || !page) return;
    page.style.transform = 'none';
    page.style.width = 'auto';
    fit.style.height = 'auto';
    var room = fit.clientWidth;
    var wanted = page.scrollWidth;
    // A pixel of slack: sub-pixel layout otherwise reports a message that fits
    // exactly as one pixel too wide, and scales the whole thing for nothing.
    if (room <= 0 || wanted <= room + 1) return;
    var scale = room / wanted;
    page.style.width = wanted + 'px';
    page.style.transform = 'scale(' + scale + ')';
    fit.style.height = Math.ceil(page.offsetHeight * scale) + 'px';
  }

  // The body's own height, and deliberately NOT the document element's. The
  // root's scroll height is never less than the frame it is drawn in, so
  // measuring it can only ever hand back the height the frame already had: a
  // two-line "thanks, received" reported the opening height and stayed a
  // 400-pixel box of white for the whole of its life.
  function measure(){
    var body = document.body;
    if (!body) return 0;
    return Math.max(body.scrollHeight, body.offsetHeight);
  }

  function send(){
    fitToWidth();
    var h = measure();
    if (h === last) return;
    // A frame that is told its own height can change height because of it, and
    // two layouts that disagree would otherwise talk to one another for ever.
    // High enough that no real message reaches it: sends are gathered up a
    // frame at a time below, so a newsletter with two hundred pictures in it
    // costs a handful of them rather than one apiece.
    if (sent > 200) return;
    last = h;
    sent++;
    parent.postMessage({ uinFrameHeight: h }, '*');
  }

  // Pictures arrive in a flurry and every one of them changes the answer.
  // Gathering them up means the work is done once when the flurry is over
  // rather than once per picture.
  function schedule(){
    if (pending) return;
    pending = true;
    setTimeout(function(){ pending = false; send(); }, 16);
  }

  window.addEventListener('load', schedule);
  window.addEventListener('resize', schedule);
  document.addEventListener('toggle', schedule, true);
  // Pictures arrive after the markup does, and every one of them makes the
  // message taller than it was when it was first measured.
  document.addEventListener('load', schedule, true);
  document.addEventListener('error', schedule, true);
  if (window.ResizeObserver) {
    var observer = new ResizeObserver(schedule);
    observer.observe(doc);
    if (document.body) observer.observe(document.body);
  }
  schedule();
  setTimeout(schedule, 400);

  // The page around the frame says back how much room it actually gave. Only
  // then does the frame stop scrolling itself. Hiding its scrollbar before the
  // room was granted would turn a message the page would not make tall enough
  // into a message with no way to reach the rest of it.
  window.addEventListener('message', function(event){
    if (event.source !== parent) return;
    var applied = event.data && event.data.uinAppliedHeight;
    if (typeof applied !== 'number') return;
    doc.style.overflowY = applied + 1 >= last ? 'hidden' : '';
  });

  document.addEventListener('click', function(event){
    if (event.defaultPrevented) return;
    // Left button only. A middle-click or a cmd-click is somebody deliberately
    // asking for a new tab, and target="_blank" already does that.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var node = event.target;
    while (node && node.nodeName !== 'A') node = node.parentNode;
    if (!node || !node.getAttribute('href')) return;
    event.preventDefault();
    parent.postMessage({
      uinLink: {
        href: String(node.href || node.getAttribute('href') || ''),
        text: String(node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300)
      }
    }, '*');
  }, true);
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
  // Two boxes round the message, and only the outer one ever does anything: the
  // inner is what gets scaled when the message is wider than the frame, and the
  // outer is what holds the room the scaled message actually takes up. See
  // fitToWidth. A message that fits is laid out exactly as it would have been
  // without them.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${FRAME_STYLES}</style></head>
<body><div id="uin-fit"><div id="uin-doc">${content}</div></div>${frameScript(nonce)}</body></html>`
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
