import { describe, it, expect } from 'vitest'
import { blockRemoteImages, htmlToText, prepareInboundHtml, readableHtml, REMOTE_SRC_ATTR } from './html'

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
