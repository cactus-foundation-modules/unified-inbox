import { describe, it, expect } from 'vitest'
import { buildMessageDocument, messageDocumentCsp, openLinksInNewTab } from './message-document'

describe('openLinksInNewTab', () => {
  it('opens links away from the sandboxed frame, telling the far end nothing', () => {
    const out = openLinksInNewTab('<a href="https://example.com">click</a>')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
  })

  it('leaves an anchor with no href alone', () => {
    expect(openLinksInNewTab('<a name="top"></a>')).toBe('<a name="top"></a>')
  })

  it('does not overrule a target the sanitiser already allowed through', () => {
    const out = openLinksInNewTab('<a href="https://x.example" target="_self">x</a>')
    expect(out).toContain('target="_self"')
    expect(out).not.toContain('target="_blank"')
  })
})

describe('buildMessageDocument', () => {
  it('folds the quoted history behind something the reader can open', () => {
    const doc = buildMessageDocument({
      html: '<p>Yes, fine.</p><blockquote>the whole of last month</blockquote>',
      nonce: 'abc',
    })
    expect(doc).toContain('<details class="uin-quote">')
    expect(doc).toContain('Show the earlier messages')
    // The history is still there, folded rather than lost.
    expect(doc).toContain('the whole of last month')
  })

  it('leaves a message with no quoted history unfolded', () => {
    const doc = buildMessageDocument({ html: '<p>Just checking in.</p>', nonce: 'abc' })
    expect(doc).not.toContain('<details class="uin-quote">')
  })

  it('puts the message in the two boxes the fit-to-width scaling needs', () => {
    const doc = buildMessageDocument({ html: '<p>hi</p>', nonce: 'abc' })
    // The scaled box has to be inside the box that holds the room it takes up,
    // and the message inside that. Flatten either of them and a message wider
    // than the frame goes back to having a scrollbar along the bottom.
    expect(doc).toContain('<div id="uin-fit"><div id="uin-doc"><p>hi</p></div></div>')
  })

  it('keeps a proxy from rewriting the message on its way out', () => {
    const doc = buildMessageDocument({ html: '<p>write to hi@example.com</p>', nonce: 'abc' })
    // Cloudflare sits in front of a good many sites, and left to itself it
    // swaps every address in this document for a placeholder and rewrites the
    // one script into something no browser runs. Both of its opt-outs are here
    // because both failures land on the reader rather than in a log.
    expect(doc).toContain('<!--email_off-->')
    expect(doc).toContain('<!--/email_off-->')
    expect(doc).toContain('data-cfasync="false"')
  })

  it('only clips the message once something has scaled it to fit', () => {
    const doc = buildMessageDocument({ html: '<p>hi</p>', nonce: 'abc' })
    // A box that clips without scaling is a message with its right-hand side
    // removed and no way to reach it, which is what a frame whose script never
    // ran would otherwise show.
    expect(doc).toContain('#uin-fit.uin-fitted { overflow: hidden; }')
    expect(doc).not.toContain('#uin-fit { overflow: hidden; }')
  })

  it('never tells the message that a word may break anywhere', () => {
    const doc = buildMessageDocument({ html: '<p>hi</p>', nonce: 'abc' })
    // word-break: break-word is overflow-wrap: anywhere under an older name, and
    // it drags a box's minimum width down to a single letter. Email is table
    // layout, table layout gives a column the width its contents insist on, and
    // this is how a button ends up 43 pixels wide with its own label hanging out
    // of it in white on a white page. overflow-wrap on its own does not do that.
    expect(doc).toContain('overflow-wrap: break-word;')
    expect(doc).not.toContain('word-break')
  })

  it('carries the nonce on the one script it has', () => {
    const doc = buildMessageDocument({ html: '<p>hi</p>', nonce: 'nonce-value' })
    const scripts = doc.match(/<script/g) ?? []
    expect(scripts).toHaveLength(1)
    expect(doc).toContain('<script nonce="nonce-value" data-cfasync="false">')
  })
})

describe('messageDocumentCsp', () => {
  it('lets the frame load nothing but its own pictures and its own script', () => {
    const csp = messageDocumentCsp('abc')
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("img-src 'self' data:")
    expect(csp).toContain("script-src 'nonce-abc'")
    expect(csp).toContain("frame-ancestors 'self'")
    // Nothing in a stranger's email gets to reach out anywhere.
    expect(csp).not.toContain('connect-src')
    expect(csp).toContain("form-action 'none'")
  })

  it("names the site in full, because a sandboxed frame has no 'self'", () => {
    const csp = messageDocumentCsp('abc', ['https://deskwell.co.uk'])
    expect(csp).toContain("img-src 'self' https://deskwell.co.uk data:")
  })

  it('takes more than one address, and says each of them once', () => {
    const csp = messageDocumentCsp('abc', [
      'https://deskwell.co.uk',
      'https://deskwell.co.uk',
      'https://www.deskwell.co.uk',
    ])
    expect(csp).toContain(
      "img-src 'self' https://deskwell.co.uk https://www.deskwell.co.uk data:",
    )
  })

  it('ignores an address that is not there, rather than writing an empty source', () => {
    const csp = messageDocumentCsp('abc', ['', 'https://deskwell.co.uk'])
    expect(csp).toContain("img-src 'self' https://deskwell.co.uk data:")
    expect(csp).not.toContain('  ')
  })

  // Widening where pictures may come from is not a way in for anything else:
  // the site is named for images alone and nothing else in the policy moves.
  it('does not let the site load anything but pictures', () => {
    const csp = messageDocumentCsp('abc', ['https://deskwell.co.uk'])
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("script-src 'nonce-abc'")
    expect(csp).not.toContain("script-src 'nonce-abc' https://deskwell.co.uk")
  })
})
