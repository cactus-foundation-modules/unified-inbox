import { describe, it, expect } from 'vitest'
import {
  inlineImageHref,
  isDisplayableImageType,
  matchInlinePart,
  type InlineImagePart,
} from './inline-images'

const part = (over: Partial<InlineImagePart> & { id: string }): InlineImagePart => ({
  contentId: null,
  filename: 'file.png',
  contentType: 'image/png',
  ...over,
})

describe('isDisplayableImageType', () => {
  it('accepts the picture types a browser actually renders', () => {
    expect(isDisplayableImageType('image/png')).toBe(true)
    expect(isDisplayableImageType('IMAGE/JPEG; charset=binary')).toBe(true)
  })

  it('refuses an SVG, which is markup with script in it', () => {
    expect(isDisplayableImageType('image/svg+xml')).toBe(false)
  })

  it('refuses everything that is not a picture at all', () => {
    expect(isDisplayableImageType('application/pdf')).toBe(false)
    expect(isDisplayableImageType('text/html')).toBe(false)
    expect(isDisplayableImageType(null)).toBe(false)
    expect(isDisplayableImageType('')).toBe(false)
  })
})

describe('matchInlinePart', () => {
  it('finds the part that declared the name', () => {
    const parts = [
      part({ id: 'a', contentId: 'other@x', filename: 'other.png' }),
      part({ id: 'b', contentId: 'image001.png@01D9', filename: 'image001.png' }),
    ]
    expect(matchInlinePart('image001.png@01D9', parts)?.id).toBe('b')
  })

  it('does not care about brackets or case, because senders do not', () => {
    const parts = [part({ id: 'a', contentId: '<Logo@Example>' })]
    expect(matchInlinePart('logo@example', parts)?.id).toBe('a')
    expect(matchInlinePart('<LOGO@EXAMPLE>', parts)?.id).toBe('a')
  })

  // Everything that arrived before migration 048 has no Content-ID recorded,
  // including the messages sitting in live mailboxes today. Outlook builds the
  // name out of the filename, which is what makes those readable at all.
  it('falls back to the filename for post that arrived before the name was recorded', () => {
    const parts = [part({ id: 'a', contentId: null, filename: 'image001.png' })]
    expect(matchInlinePart('image001.png@01D9A2', parts)?.id).toBe('a')
    expect(matchInlinePart('image001.png', parts)?.id).toBe('a')
  })

  it('would rather show nothing than guess between two candidates', () => {
    const parts = [
      part({ id: 'a', filename: 'logo.png' }),
      part({ id: 'b', filename: 'logo.png' }),
    ]
    expect(matchInlinePart('logo.png@one', parts)).toBeNull()
  })

  it('prefers the part that declared the name over one that merely looks like it', () => {
    const parts = [
      part({ id: 'a', contentId: null, filename: 'logo.png' }),
      part({ id: 'b', contentId: 'logo.png@real', filename: 'something-else.png' }),
    ]
    expect(matchInlinePart('logo.png@real', parts)?.id).toBe('b')
  })

  it('will not hand a PDF to an img tag, whatever the message points at', () => {
    const parts = [part({ id: 'a', contentId: 'invoice@x', filename: 'invoice.pdf', contentType: 'application/pdf' })]
    expect(matchInlinePart('invoice@x', parts)).toBeNull()
  })

  it('still offers a part whose type was never recorded, because the route checks it again', () => {
    const parts = [part({ id: 'a', contentId: 'logo@x', contentType: null })]
    expect(matchInlinePart('logo@x', parts)?.id).toBe('a')
  })

  it('has nothing to say about an empty name or an empty message', () => {
    expect(matchInlinePart('', [part({ id: 'a', contentId: 'x@y' })])).toBeNull()
    expect(matchInlinePart('x@y', [])).toBeNull()
  })

  it('does not match a part whose filename is empty against a bare name', () => {
    expect(matchInlinePart('anything', [part({ id: 'a', filename: '' })])).toBeNull()
  })
})

describe('inlineImageHref', () => {
  it('addresses the picture by the message it is in and the part that holds it', () => {
    expect(inlineImageHref('msg 1', 'att/2')).toBe(
      '/api/m/unified-inbox/messages/msg%201/inline/att%2F2',
    )
  })
})
