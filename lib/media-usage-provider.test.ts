import { describe, it, expect, vi } from 'vitest'

// An attachment must never be classified as "not in use" by the media library.
// That verdict is what arms the bulk-delete button, and what it would be
// deleting is a customer's paperwork - an invoice, a signed order, a quote
// somebody spent an afternoon on - with nothing to restore it from.
//
// The classifier is core's, and it is fed by the strings this module's usage
// provider hands over, so this exercises the pair together with the actual
// shapes an attachment produces. A change to core's tokeniser that stopped
// seeing one of them would break silently otherwise, months before anybody
// pressed the button.
vi.mock('@/lib/db/prisma', () => ({ prisma: {} }))

import { extractReferenceTokens, isMediaInUse, type MediaUsageIndex } from '@/lib/media/references'

/** The index core would build from nothing but this module's contribution. */
function indexFrom(refs: string[]): MediaUsageIndex {
  const haystack = refs.join('\n').toLowerCase()
  return {
    referencedIds: new Set<string>(),
    haystack,
    referenced: extractReferenceTokens(haystack),
    referencedViaFormerAddress: new Set<string>(),
    degraded: false,
  }
}

// One filed attachment, exactly as the columns hold it: a B2 key under the
// correspondent's folder, the Worker url for it, and the library row's cuid.
const ATTACHMENT = {
  id: 'clx3k2j9a0000qwertyuiop9',
  key: 'media/inbox/buyer-acme.co.uk/received/att-7-quote.pdf',
  url: 'https://media.example.com/media/inbox/buyer-acme.co.uk/received/att-7-quote.pdf',
}

describe('an attachment is never "not in use"', () => {
  it('is in use on the strength of its key alone', () => {
    expect(isMediaInUse(ATTACHMENT, indexFrom([ATTACHMENT.key]))).toBe(true)
  })

  it('is in use on the strength of its url alone', () => {
    expect(isMediaInUse(ATTACHMENT, indexFrom([ATTACHMENT.url]))).toBe(true)
  })

  it('is in use on the strength of its library id alone', () => {
    // The one that survives an optimise or a folder rename, both of which mint
    // a fresh key and url. Without it there is a window in which a perfectly
    // ordinary tidy-up leaves an invoice looking unreferenced.
    expect(isMediaInUse(ATTACHMENT, indexFrom([ATTACHMENT.id]))).toBe(true)
  })

  it('still recognises a filename nothing sanitised, via the substring fallback', () => {
    const odd = {
      id: 'clx3k2j9a0000qwertyuiop9',
      key: 'media/inbox/buyer-acme.co.uk/received/att-7-order note (final).pdf',
      url: 'https://media.example.com/media/inbox/buyer-acme.co.uk/received/att-7-order note (final).pdf',
    }
    expect(isMediaInUse(odd, indexFrom([odd.key, odd.url]))).toBe(true)
  })

  it('does not vouch for something this module is not holding', () => {
    // The other half of the contract: if every row came back in use the verdict
    // would be worthless, and a real leftover would sit in the bucket for ever.
    const stranger = { id: 'clx0000000000strangerrow', key: 'media/shop/chair-1.jpg', url: 'https://media.example.com/media/shop/chair-1.jpg' }
    expect(isMediaInUse(stranger, indexFrom([ATTACHMENT.key, ATTACHMENT.url, ATTACHMENT.id]))).toBe(false)
  })
})
