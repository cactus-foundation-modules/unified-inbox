import { describe, it, expect } from 'vitest'
import {
  blockRemoteImages,
  hasInlineImages,
  htmlToText,
  inlineImageCids,
  INLINE_SRC_ATTR,
  prepareInboundHtml,
  readableHtml,
  rewriteInlineImages,
  REMOTE_SRC_ATTR,
} from './html'

describe('prepareInboundHtml', () => {
  it('drops anything executable a sender put in the message', () => {
    const clean = prepareInboundHtml('<p>Hello</p><script>alert(1)</script>')
    expect(clean).toContain('Hello')
    expect(clean).not.toContain('script')
  })

  it('drops an event handler however it was written', () => {
    const clean = prepareInboundHtml('<img src="cid:logo" onerror="alert(1)">')
    expect(clean).not.toContain('onerror')
  })

  it('keeps the table markup email layout is actually built from', () => {
    const clean = prepareInboundHtml('<table cellpadding="4"><tr><td>Price</td></tr></table>')
    expect(clean).toContain('cellpadding')
    expect(clean).toContain('Price')
  })

  it('says nothing rather than null for markup that sanitises away to nothing', () => {
    expect(prepareInboundHtml('<script>alert(1)</script>')).toBe('')
  })

  it('has nothing to say about a message with no HTML part', () => {
    expect(prepareInboundHtml(null)).toBeNull()
  })
})

describe('blockRemoteImages', () => {
  it('defuses a tracking pixel rather than fetching it the moment a message is opened', () => {
    const blocked = blockRemoteImages('<img src="https://tracker.example/pixel.gif" width="1">')
    // No src left for a browser to act on, and the address parked where the
    // reader can ask for it deliberately.
    expect(/<img[^>]*\ssrc\s*=/.test(blocked)).toBe(false)
    expect(blocked).toContain(`${REMOTE_SRC_ATTR}="https://tracker.example/pixel.gif"`)
  })

  it('leaves an image that came with the message alone', () => {
    const html = '<img src="cid:logo@example">'
    expect(blockRemoteImages(html)).toBe(html)
  })

  it('strips a remote background attribute too', () => {
    expect(blockRemoteImages('<td background="https://tracker.example/bg.png">x</td>'))
      .not.toContain('tracker.example')
  })
})

describe('htmlToText', () => {
  it('gives a message that arrived as HTML only something readable', () => {
    expect(htmlToText('<p>Hello</p><p>Goodbye</p>')).toBe('Hello\nGoodbye')
  })

  it('turns line breaks into line breaks', () => {
    expect(htmlToText('one<br>two')).toBe('one\ntwo')
  })

  it('unescapes the entities a mail client leaves behind', () => {
    expect(htmlToText('<p>Tea &amp; biscuits</p>')).toBe('Tea & biscuits')
  })
})

describe('readableHtml', () => {
  // The defect this exists for: a message WE sent is stored with its remote
  // addresses intact, and the frame it is read in allows pictures from this
  // origin and nowhere else. Every product photo on our own media host came out
  // as an empty box until the read path parked them too.
  it('parks a picture the write path never parked, so our own post can be read', () => {
    const stored = '<img src="https://media.example/shop/chair.webp" width="64" height="64" />'
    const readable = readableHtml(stored)!
    // Not merely "the address moved": the tag must be left with no src at all,
    // which is the whole of what stops the frame fetching it.
    expect(readable).not.toMatch(/\ssrc=/)
    expect(readable).toContain(`${REMOTE_SRC_ATTR}="https://media.example/shop/chair.webp"`)
    expect(readable).toContain('width="64"')
  })

  it('leaves an already parked picture exactly as it is', () => {
    const stored = prepareInboundHtml('<img src="https://tracker.example/pixel.gif">')!
    expect(readableHtml(stored)).toBe(stored)
  })

  it('does not touch an attachment embedded in the message itself', () => {
    const stored = '<img src="cid:logo@1">'
    expect(readableHtml(stored)).toBe(stored)
  })

  it('keeps nothing and something apart', () => {
    expect(readableHtml(null)).toBeNull()
    expect(readableHtml(undefined)).toBeNull()
    expect(readableHtml('')).toBe('')
  })
})

describe('hasInlineImages', () => {
  it('spots a picture the message brought with it', () => {
    expect(hasInlineImages('<p>Hi</p><img src="cid:image001.png@01D9">')).toBe(true)
    expect(hasInlineImages("<img src='cid:logo'>")).toBe(true)
  })

  it('is not fooled by the word appearing in the text', () => {
    expect(hasInlineImages('<p>Our reference is cid:4471</p>')).toBe(false)
    expect(hasInlineImages('<img src="https://example.com/logo.png">')).toBe(false)
    expect(hasInlineImages(null)).toBe(false)
  })
})

describe('inlineImageCids', () => {
  it('reads the names in the order they appear, brackets and all', () => {
    const html = '<img src="cid:<a@b>"><p>x</p><img src=\'cid:second.png\'>'
    expect(inlineImageCids(html)).toEqual(['a@b', 'second.png'])
  })

  it('ignores the pictures that are not in the message', () => {
    expect(inlineImageCids('<img src="https://example.com/x.png">')).toEqual([])
  })
})

describe('rewriteInlineImages', () => {
  // The defect this exists for: a signature written in Outlook carries its logo
  // INSIDE the message and points at it by Content-ID. Nothing resolved that,
  // so every one of them drew an empty box - under a note telling the reader
  // that anything carried inside the message was already there.
  it('points a picture at the part of the message that holds it', () => {
    const html = '<img src="cid:image001.png@01D9" width="120" alt="Logo">'
    const out = rewriteInlineImages(html, () => '/api/m/unified-inbox/messages/m1/inline/a1')
    expect(out).toContain('src="/api/m/unified-inbox/messages/m1/inline/a1"')
    expect(out).not.toContain('cid:')
    expect(out).toContain('width="120"')
    expect(out).toContain('alt="Logo"')
  })

  it('hands over the name without its brackets, however the sender wrote it', () => {
    const seen: string[] = []
    rewriteInlineImages("<img src='cid:<Logo@Example>'>", (cid) => { seen.push(cid); return null })
    expect(seen).toEqual(['Logo@Example'])
  })

  it('leaves a picture with no src at all when nothing answers to the name', () => {
    const out = rewriteInlineImages('<img src="cid:missing@1" alt="Quote">', () => null)
    // A src pointing at cid: is a broken picture in every browser there is, so
    // the tag keeps its alt text instead and the name is parked for later.
    expect(out).not.toMatch(/\ssrc=/)
    expect(out).toContain(`${INLINE_SRC_ATTR}="missing@1"`)
    expect(out).toContain('alt="Quote"')
  })

  it('does not touch a picture kept on a server somewhere else', () => {
    const html = '<img src="https://tracker.example/pixel.gif">'
    expect(rewriteInlineImages(html, () => '/nope')).toBe(html)
  })

  it('leaves a parked remote picture parked', () => {
    const stored = blockRemoteImages('<img src="https://tracker.example/pixel.gif">')
    expect(rewriteInlineImages(stored, () => '/nope')).toBe(stored)
  })

  it('can be run twice without doing anything the second time', () => {
    const once = rewriteInlineImages('<img src="cid:a@b"><img src="cid:c@d">', (cid) =>
      cid === 'a@b' ? '/api/m/unified-inbox/messages/m1/inline/a1' : null)
    expect(rewriteInlineImages(once, () => '/somewhere/else')).toBe(once)
  })

  it('rewrites every picture in the message, each to its own part', () => {
    const html = '<img src="cid:one@x"><p>then</p><img src="cid:two@x">'
    const out = rewriteInlineImages(html, (cid) => `/inline/${cid.split('@')[0]}`)
    expect(out).toContain('src="/inline/one"')
    expect(out).toContain('src="/inline/two"')
  })
})
