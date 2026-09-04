import { describe, it, expect, vi, beforeEach } from 'vitest'

// Filing a module's automatic email as a conversation.
//
// Two things worth holding down. Nothing is filed for a module the site has not
// given an inbox to - there would be no address for anybody to reply to, and an
// unasked-for conversation appearing in a mailbox is a surprise nobody wants.
// And what IS filed carries the service's own Message-ID, because that is the
// handle the supplier's reply comes back on and the entire reason the copy is
// worth keeping.

const senders = vi.hoisted(() => ({ getModuleSenderInboxId: vi.fn() }))
vi.mock('./module-senders', () => senders)

const db = vi.hoisted(() => ({
  getInbox: vi.fn(),
  createOutboundThread: vi.fn(),
  insertOutboundMessage: vi.fn(),
  insertOutboundAttachment: vi.fn(),
  settleDelivery: vi.fn(),
}))
vi.mock('./db', () => db)

const media = vi.hoisted(() => ({
  getActiveMediaProvider: vi.fn(),
  isMediaProviderConfigured: vi.fn(),
}))
vi.mock('@/lib/config/env', () => media)

const cache = vi.hoisted(() => ({ cacheAttachment: vi.fn(), attachmentKey: vi.fn() }))
vi.mock('./attachments', () => cache)

import { unifiedInboxOutboundRecord } from './outbound-record'

const EMAIL = {
  moduleName: 'purchase-orders',
  from: { name: 'Deskwell Purchasing', address: 'purchasing@deskwell.co.uk' },
  to: ['sales@supplier.com'],
  cc: [],
  subject: 'Purchase order PO-1042',
  html: '<p>Here is our order.</p>',
  text: 'Here is our order.',
  providerMessageId: '<brevo-1@smtp-relay.sendinblue.com>',
  sentAt: new Date('2026-09-04T10:00:00Z'),
  attachments: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  db.getInbox.mockResolvedValue({ id: 'inbox-1', address: 'purchasing@deskwell.co.uk' })
  db.createOutboundThread.mockResolvedValue('thread-1')
  db.insertOutboundMessage.mockResolvedValue({ row: { id: 'message-1' }, created: true })
  media.getActiveMediaProvider.mockResolvedValue('B2')
  media.isMediaProviderConfigured.mockReturnValue(true)
})

describe('filing a module email', () => {
  it('files nothing for a module with no inbox of its own', async () => {
    senders.getModuleSenderInboxId.mockResolvedValue(null)
    await unifiedInboxOutboundRecord.record(EMAIL)
    expect(db.createOutboundThread).not.toHaveBeenCalled()
    expect(db.insertOutboundMessage).not.toHaveBeenCalled()
  })

  it('files nothing when the chosen inbox has gone', async () => {
    senders.getModuleSenderInboxId.mockResolvedValue('inbox-1')
    db.getInbox.mockResolvedValue(null)
    await unifiedInboxOutboundRecord.record(EMAIL)
    expect(db.createOutboundThread).not.toHaveBeenCalled()
  })

  it('starts a conversation in the inbox the module writes from', async () => {
    senders.getModuleSenderInboxId.mockResolvedValue('inbox-1')
    await unifiedInboxOutboundRecord.record(EMAIL)

    expect(db.createOutboundThread).toHaveBeenCalledWith(
      expect.objectContaining({ inboxId: 'inbox-1', subject: 'Purchase order PO-1042' }),
    )
    expect(db.insertOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        inboxId: 'inbox-1',
        fromAddress: 'purchasing@deskwell.co.uk',
        toAddresses: ['sales@supplier.com'],
        // Nobody typed it, so nobody signed it.
        authorUserId: null,
      }),
    )
  })

  it('strips the brackets off a Message-ID core put on it', async () => {
    senders.getModuleSenderInboxId.mockResolvedValue('inbox-1')
    await unifiedInboxOutboundRecord.record({ ...EMAIL, messageIdHeader: '<uin.abc@deskwell.co.uk>' })
    expect(db.insertOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageIdHeader: 'uin.abc@deskwell.co.uk' }),
    )
  })

  it('keeps the service\'s own id, which is what a reply comes back on', async () => {
    senders.getModuleSenderInboxId.mockResolvedValue('inbox-1')
    await unifiedInboxOutboundRecord.record(EMAIL)
    expect(db.settleDelivery).toHaveBeenCalledWith('message-1', {
      status: 'sent',
      providerMessageId: 'brevo-1@smtp-relay.sendinblue.com',
    })
  })

  it('keeps the document that travelled with it', async () => {
    senders.getModuleSenderInboxId.mockResolvedValue('inbox-1')
    db.insertOutboundAttachment.mockResolvedValue('attachment-1')
    await unifiedInboxOutboundRecord.record({
      ...EMAIL,
      attachments: [
        { filename: 'PO-1042.pdf', content: Buffer.from('an order'), contentType: 'application/pdf' },
      ],
    })

    expect(db.insertOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ hasAttachments: true }),
    )
    expect(cache.cacheAttachment).toHaveBeenCalledWith(
      { id: 'attachment-1', messageId: 'message-1', filename: 'PO-1042.pdf' },
      expect.any(Buffer),
      'application/pdf',
    )
  })

  it('claims no attachment on a site with nowhere to keep one', async () => {
    senders.getModuleSenderInboxId.mockResolvedValue('inbox-1')
    media.isMediaProviderConfigured.mockReturnValue(false)
    await unifiedInboxOutboundRecord.record({
      ...EMAIL,
      attachments: [
        { filename: 'PO-1042.pdf', content: Buffer.from('an order'), contentType: 'application/pdf' },
      ],
    })

    expect(db.insertOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ hasAttachments: false }),
    )
    expect(db.insertOutboundAttachment).not.toHaveBeenCalled()
  })
})
