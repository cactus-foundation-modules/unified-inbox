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
 *  module overruling the sender about what their message looks like.
 *
 *  `overflow-wrap` is here and `word-break` is deliberately NOT, and the
 *  difference is not the hair-splitting it looks. `overflow-wrap: break-word`
 *  breaks a word that has nowhere else to go and changes nothing about how wide
 *  a box wants to be. `word-break: break-word` is the legacy spelling of
 *  `overflow-wrap: anywhere`, and THAT one feeds back into intrinsic sizing: a
 *  box's minimum width stops being "as wide as its longest word" and becomes "as
 *  wide as one letter". Almost every marketing email is a table, and a table
 *  hands each column the width its contents insist on - so telling the whole
 *  document that nothing insists on any width lets those columns collapse.
 *
 *  In Safari that is exactly what happened, and it is nastier than it sounds:
 *  the button in a WhatsApp notification came out 43 pixels wide instead of 188,
 *  its label still set to never wrap and still painted white, so the words ran
 *  out of the blue box onto the white page and simply disappeared. A button
 *  reading "View" instead of "View in WhatsApp Manager", with no clue anywhere
 *  that anything had gone wrong. Chrome and Firefox both render it correctly,
 *  which is the other half of why it took some finding. */
const FRAME_STYLES = `
  html, body { margin: 0; padding: 0; }
  body {
    background: #ffffff;
    color: #1a1a1a;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 0.9375rem;
    line-height: 1.55;
    overflow-wrap: break-word;
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
     as the message ended up. A message that already fits is not touched.

     The clipping is switched on by the script, not by this stylesheet, and that
     is deliberate. Clipping is only ever right once something has scaled the
     message to fit inside it; on its own it is a message with its right-hand
     side cut off and no way to reach it. So if the script does not run at all -
     an extension, a blocked nonce, a proxy that rewrote the tag - the message
     overflows visibly and can still be read, which is the better of the two
     wrong answers. */
  #uin-fit.uin-fitted { overflow: hidden; }
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
 *
 * `data-cfasync="false"` is what keeps it running at all on a site sat behind
 * Cloudflare, and it is not optional. Cloudflare's Rocket Loader rewrites every
 * script tag in an HTML response it touches - `type="javascript"` becomes
 * `type="<token>-text/javascript"`, which no browser will execute - and then
 * loads a script of its own to run them in its own order. That script comes
 * from Cloudflare, this document's policy allows precisely one nonce and
 * nothing else, so the policy blocks the only thing that could have started
 * ours. The frame then reports no height, fits nothing to the width, and sits
 * at its opening size with the message cut off inside it - which is exactly
 * what it looks like when a message "displays weirdly" on a Cloudflare site and
 * nowhere else. The attribute is Cloudflare's own opt-out, and it is inert
 * anywhere Cloudflare is not.
 */
function frameScript(nonce: string): string {
  return `<script nonce="${nonce}" data-cfasync="false">(function(){
  var doc = document.documentElement;
  // Ours, and first in the body, so an email carrying an id of the same name
  // cannot be picked up instead: getElementById answers in document order.
  var fit = document.getElementById('uin-fit');
  var page = fit ? fit.firstElementChild : null;
  var last = 0;
  // The height reported before the current one. Two heights that keep swapping
  // places are two layouts arguing with each other, and the guard at the bottom
  // of send() settles that argument on the taller of the two.
  var beforeLast = -1;
  var sent = 0;
  var pending = false;
  // A pixel or two of slack on every answer.
  //
  // This is the whole of why messages kept arriving with a scrollbar inside
  // them. scrollHeight is an INTEGER: a message that is genuinely 500.4 pixels
  // tall reports 500, the frame is made 500 tall, and the four tenths left over
  // are a scrollbar over the whole message. Sub-pixel layout is the normal case
  // - line heights in rem, images at 100% of an odd width, a table with a
  // fractional border - so this was most messages, not a few. Two pixels of
  // white under the shortest message is the price, and it is worth paying.
  var SLACK = 2;

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
    // Nothing is clipped until this pass has decided to scale something. See
    // the stylesheet: a box that clips without scaling is a message with its
    // right-hand side quietly removed.
    fit.className = '';
    var room = fit.clientWidth;
    var wanted = page.scrollWidth;
    // A pixel of slack: sub-pixel layout otherwise reports a message that fits
    // exactly as one pixel too wide, and scales the whole thing for nothing.
    if (room <= 0 || wanted <= room + 1) return;
    var scale = room / wanted;
    page.style.width = wanted + 'px';
    // Measured while the transform is still off, so this is the LAYOUT height -
    // a rect read after the scale is applied is already the scaled one, and
    // scaling it again would halve the message. Fractional rather than
    // offsetHeight: an integer multiplied by a fraction and then rounded loses
    // up to a pixel, and a pixel lost here is the same scrollbar the slack above
    // exists to stop.
    var natural = page.getBoundingClientRect().height;
    page.style.transform = 'scale(' + scale + ')';
    fit.style.height = Math.ceil(natural * scale) + 'px';
    fit.className = 'uin-fitted';
  }

  // The body's own height, and deliberately NOT the document element's. The
  // root's scroll height is never less than the frame it is drawn in, so
  // measuring it can only ever hand back the height the frame already had: a
  // two-line "thanks, received" reported the opening height and stayed a
  // 400-pixel box of white for the whole of its life.
  //
  // Read three ways and the tallest answer taken. getBoundingClientRect is the
  // fractional one and is what stops the rounding-down scrollbar described
  // above; scrollHeight is the one that still sees a child hanging out of the
  // flow; offsetHeight is the belt to their braces. Rounded UP, never down, and
  // then given its slack.
  function measure(){
    var body = document.body;
    if (!body) return 0;
    var rect = body.getBoundingClientRect();
    var tallest = Math.max(rect.height, body.scrollHeight, body.offsetHeight);
    return Math.ceil(tallest) + SLACK;
  }

  function send(){
    fitToWidth();
    var h = measure();
    if (h === last) return;
    // A frame that is told its own height can change height because of it, so
    // two layouts that disagree can talk to one another for ever. When the new
    // answer is the one BEFORE the current one, that is exactly what is
    // happening - and it is settled on the taller of the two, because a frame a
    // pixel too tall costs a hairline of white and a frame a pixel too short
    // costs a scrollbar over the whole message.
    if (h === beforeLast) {
      if (h > last) {
        beforeLast = last;
        last = h;
        parent.postMessage({ uinFrameHeight: h }, '*');
      }
      return;
    }
    // A runaway guard and nothing else, and generous: sends are gathered up a
    // frame at a time below, so a newsletter with three hundred pictures in it
    // costs a handful rather than one apiece. It used to be 200, which a long
    // enough message could genuinely reach - and reaching it meant the frame
    // stopped reporting while it was still growing, which is a message you
    // scroll inside.
    if (sent > 500) return;
    beforeLast = last;
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

  // The page around the frame says back how much room it actually gave, once it
  // has actually given it. Only then does the frame stop scrolling itself:
  // hiding the scrollbar before the room was granted would turn a message the
  // page would not make tall enough into a message with no way to reach the
  // rest of it.
  //
  // The slack above is what makes this reliable. The room granted is now always
  // a pixel or two MORE than the message needs, so the comparison is never lost
  // to a rounding error, and a message that fits genuinely reads as one that
  // fits.
  window.addEventListener('message', function(event){
    if (event.source !== parent) return;
    var applied = event.data && event.data.uinAppliedHeight;
    if (typeof applied !== 'number') return;
    doc.style.overflowY = applied + 1 >= last ? 'hidden' : 'auto';
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
  //
  // The email_off comments are Cloudflare's opt-out from address obfuscation,
  // and they matter here for a reason that does not apply to a normal page.
  // Cloudflare rewrites any address it finds in an HTML response into the words
  // "[email protected]" plus a script that puts the real one back - which is a
  // fair trade on a public page being read by spam harvesters, and nonsense
  // inside somebody's own inbox. Worse, the script that would restore it comes
  // from Cloudflare, and this document's policy allows one nonce and nothing
  // else, so it never runs: the reader is left looking at a message where every
  // address has been replaced by a placeholder that will never turn back. These
  // two comments cost a few bytes and are ignored everywhere else.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${FRAME_STYLES}</style></head>
<body><!--email_off--><div id="uin-fit"><div id="uin-doc">${content}</div></div><!--/email_off-->${frameScript(nonce)}</body></html>`
}

/**
 * The frame's own content policy: nothing loads from anywhere, except pictures
 * from this site (which is where the picture proxy serves them from) and the
 * one script carrying this nonce. No fetching, no forms, no frames of its own,
 * and nothing may frame it but this site.
 *
 * `origins` is this site's own address, written out in full, and leaving it off
 * is what stopped the pictures ever appearing. The frame is sandboxed WITHOUT
 * allow-same-origin - which is the whole point of it, since that is what keeps a
 * stranger's email away from this site's cookies - and a document with no origin
 * of its own has nothing for `'self'` to mean. So `img-src 'self'` matched
 * precisely nothing, including the proxy's own pictures, and every picture in
 * every message came out broken with no error anywhere to say why. Naming the
 * address in full is a source the browser can actually compare against.
 *
 * `'self'` stays beside it. It costs nothing and is the right answer if this
 * document is ever served somewhere it has an origin of its own.
 */
export function messageDocumentCsp(nonce: string, origins: readonly string[] = []): string {
  const hosts = Array.from(new Set(origins.filter(Boolean)))
  return [
    `default-src 'none'`,
    [`img-src 'self'`, ...hosts, 'data:'].join(' '),
    `style-src 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src data:`,
    `form-action 'none'`,
    `base-uri 'none'`,
    `frame-ancestors 'self'`,
  ].join('; ')
}
