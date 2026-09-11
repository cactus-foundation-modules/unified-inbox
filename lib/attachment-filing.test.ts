import { describe, it, expect, vi, beforeEach } from 'vitest'

const media = vi.hoisted(() => ({ deleteMedia: vi.fn() }))
const rows = vi.hoisted(() => ({ deleteMany: vi.fn() }))
const store = vi.hoisted(() => ({ attachmentKeySharedElsewhere: vi.fn(async (): Promise<boolean> => false) }))

// The folder an attachment lands in is a decision about who can see a
// customer's paperwork, so it is worth pinning down without a database in the
// way. Only the pure half is exercised here - the half that decides - and the
// three core modules it sits next to are stubbed out because importing them
// drags in Prisma.
vi.mock('@/lib/db/prisma', () => ({ prisma: { media: { deleteMany: rows.deleteMany } } }))
vi.mock('@/lib/media/organise', () => ({
  getOrCreateFolderByPath: vi.fn(),
  resolveFolderPath: vi.fn(),
}))
vi.mock('./db', () => store)
vi.mock('@/lib/media/upload', () => ({
  deleteMedia: media.deleteMedia,
  mediaKeyPrefix: (provider: string) => (provider === 'B2' ? 'media/' : `media/${provider}/`),
}))

import { filedAttachmentKey, filingFor, releaseStoredObject } from './attachment-filing'

const BASE = { direction: 'in', fromAddress: null, toAddresses: [], contentId: null }

describe('filingFor', () => {
  it('files a received message under whoever sent it', () => {
    expect(filingFor({ ...BASE, direction: 'in', fromAddress: 'buyer@acme.co.uk' }))
      .toEqual({ address: 'buyer@acme.co.uk', leaf: 'Received' })
  })

  it('files a sent message under whoever it went TO, not the address it went from', () => {
    // The whole point of the rule: filing Sent by From would pile every reply
    // the site has ever written into a folder named after the site.
    expect(filingFor({
      ...BASE,
      direction: 'out',
      fromAddress: 'hi@deskwell.co.uk',
      toAddresses: ['buyer@acme.co.uk', 'someone.else@acme.co.uk'],
    })).toEqual({ address: 'buyer@acme.co.uk', leaf: 'Sent' })
  })

  it('lower-cases the address so one correspondent is one folder', () => {
    expect(filingFor({ ...BASE, direction: 'in', fromAddress: '  Buyer@Acme.co.uk ' })?.address)
      .toBe('buyer@acme.co.uk')
  })

  it('leaves an inline part out of the library entirely', () => {
    // A signature logo on every email from a company with a fancy footer. In
    // the library they would outnumber everything a person actually attached.
    expect(filingFor({
      ...BASE,
      direction: 'in',
      fromAddress: 'buyer@acme.co.uk',
      contentId: 'image001.png@01D9',
    })).toBeNull()
  })

  it('leaves an internal note out of the library', () => {
    expect(filingFor({ ...BASE, direction: 'note', fromAddress: 'staff@deskwell.co.uk' })).toBeNull()
  })

  it('leaves a message with no correspondent out of the library', () => {
    expect(filingFor({ ...BASE, direction: 'in', fromAddress: null })).toBeNull()
    expect(filingFor({ ...BASE, direction: 'out', toAddresses: [] })).toBeNull()
  })
})

describe('filedAttachmentKey', () => {
  it('puts the attachment id in front of the name, inside the provider prefix', () => {
    expect(filedAttachmentKey('B2', 'inbox/buyer-acme.co.uk/received', 'att-7', 'quote.pdf'))
      .toBe('media/inbox/buyer-acme.co.uk/received/att-7-quote.pdf')
  })

  it('keeps a non-B2 provider inside its own namespace', () => {
    expect(filedAttachmentKey('R2', 'inbox/buyer-acme.co.uk/sent', 'att-7', 'quote.pdf'))
      .toBe('media/R2/inbox/buyer-acme.co.uk/sent/att-7-quote.pdf')
  })
})


describe('releaseStoredObject', () => {
  beforeEach(() => {
    media.deleteMedia.mockReset()
    rows.deleteMany.mockReset()
    store.attachmentKeySharedElsewhere.mockReset()
    // Nothing else is holding the same bytes unless a test says so.
    store.attachmentKeySharedElsewhere.mockResolvedValue(false)
  })

  const OURS = {
    attachmentId: 'att-1',
    mediaKey: 'media/inbox/buyer-acme.co.uk/received/att-1-quote.pdf',
    mediaProvider: 'B2',
    mediaId: 'clx3k2j9a0000qwertyuiop9',
    ownsObject: true,
  }

  it('takes the bytes and the library row when the file belongs to this module', async () => {
    await releaseStoredObject(OURS)
    expect(media.deleteMedia).toHaveBeenCalledWith('B2', OURS.mediaKey)
    expect(rows.deleteMany).toHaveBeenCalledWith({ where: { id: OURS.mediaId } })
  })

  it('leaves a file somebody attached from the media library completely alone', async () => {
    // The bug this column exists for: emptying the bin used to delete a product
    // photograph out of storage because an email had once been sent with it,
    // and leave the shop's own library row pointing at nothing.
    await releaseStoredObject({
      attachmentId: 'att-2',
      mediaKey: 'media/shop/office-tables/chair-1.jpg',
      mediaProvider: 'B2',
      mediaId: null,
      ownsObject: false,
    })
    expect(media.deleteMedia).not.toHaveBeenCalled()
    expect(rows.deleteMany).not.toHaveBeenCalled()
  })

  it('still removes the bytes when there was never a library row', async () => {
    // An inline part, or a message with no correspondent: stored, ours, and
    // deliberately never filed.
    await releaseStoredObject({ ...OURS, mediaId: null })
    expect(media.deleteMedia).toHaveBeenCalledWith('B2', OURS.mediaKey)
    expect(rows.deleteMany).not.toHaveBeenCalled()
  })

  it('leaves the bytes alone while a forward of the message still points at them', async () => {
    // A forward travels with the original's attachment and its row carries the
    // same key. Deleting either message must not take the file off the other.
    store.attachmentKeySharedElsewhere.mockResolvedValue(true)
    await releaseStoredObject(OURS)
    expect(media.deleteMedia).not.toHaveBeenCalled()
    expect(rows.deleteMany).not.toHaveBeenCalled()
  })

  it('does not even ask about sharing for a file it does not own', async () => {
    await releaseStoredObject({ ...OURS, ownsObject: false })
    expect(store.attachmentKeySharedElsewhere).not.toHaveBeenCalled()
  })
})
