import { describe, it, expect, vi, beforeEach } from 'vitest'

// Filing a module's automatic email as a conversation.
//
// Two things worth holding down. Nothing is filed for a module the site has not
// picked a filing inbox for - an unasked-for conversation appearing in a
// mailbox is a surprise nobody wants, and since migration 046 that choice is
// its own switch rather than a side effect of choosing a sending address.
// And what IS filed carries the service's own Message-ID, because that is the
// handle the supplier's reply comes back on and the entire reason the copy is
// worth keeping.

const senders = vi.hoisted(() => ({ getModuleCopyInboxId: vi.fn() }))
vi.mock('./module-senders', () => senders)

const db = vi.hoisted(() => ({
  getInbox: vi.fn(),
  listInboxes: vi.fn(),
  createOutboundThread: vi.fn(),
  findThreadByKey: vi.fn(),
  touchThread: vi.fn(),
  insertOutboundMessage: vi.fn(),
  insertOutboundAttachment: vi.fn(),
  settleDelivery: vi.fn(),
  reopenOnReply: vi.fn(),
  recordEvent: vi.fn(),
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
  db.findThreadByKey.mockResolvedValue(null)
  db.reopenOnReply.mockResolvedValue(null)
  db.listInboxes.mockResolvedValue([{ id: 'inbox-1', address: 'purchasing@deskwell.co.uk' }])
  db.insertOutboundMessage.mockResolvedValue({ row: { id: 'message-1' }, created: true })
  media.getActiveMediaProvider.mockResolvedValue('B2')
  media.isMediaProviderConfigured.mockReturnValue(true)
})

describe('filing a module email', () => {
  it('files nothing for a module nobody has asked for copies of', async () => {
    senders.getModuleCopyInboxId.mockResolvedValue(null)
    await unifiedInboxOutboundRecord.record(EMAIL)
    expect(db.createOutboundThread).not.toHaveBeenCalled()
    expect(db.insertOutboundMessage).not.toHaveBeenCalled()
  })

  it('files nothing when the chosen inbox has gone', async () => {
    senders.getModuleCopyInboxId.mockResolvedValue('inbox-1')
    db.getInbox.mockResolvedValue(null)
    await unifiedInboxOutboundRecord.record(EMAIL)
    expect(db.createOutboundThread).not.toHaveBeenCalled()
  })

  it('starts a conversation in the inbox chosen for its copies', async () => {
    senders.getModuleCopyInboxId.mockResolvedValue('inbox-1')
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
    senders.getModuleCopyInboxId.mockResolvedValue('inbox-1')
    await unifiedInboxOutboundRecord.record({ ...EMAIL, messageIdHeader: '<uin.abc@deskwell.co.uk>' })
    expect(db.insertOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageIdHeader: 'uin.abc@deskwell.co.uk' }),
    )
  })

  it('keeps the service\'s own id, which is what a reply comes back on', async () => {
    senders.getModuleCopyInboxId.mockResolvedValue('inbox-1')
    await unifiedInboxOutboundRecord.record(EMAIL)
    expect(db.settleDelivery).toHaveBeenCalledWith('message-1', {
      status: 'sent',
      providerMessageId: 'brevo-1@smtp-relay.sendinblue.com',
      // Nothing from core about the send on this fixture, so nothing claimed.
      tracking: { emailLogId: null, sentVia: null, tracked: false },
    })
  })

  it('keeps the log row core wrote, so the site\'s own tracking can find the copy', async () => {
    senders.getModuleCopyInboxId.mockResolvedValue('inbox-1')
    await unifiedInboxOutboundRecord.record({ ...EMAIL, emailLogId: 'log-7', transport: 'smtp', tracked: true })
    expect(db.settleDelivery).toHaveBeenCalledWith('message-1', expect.objectContaining({
      tracking: { emailLogId: 'log-7', sentVia: 'smtp', tracked: true },
    }))
  })

  it('keeps the document that travelled with it', async () => {
    senders.getModuleCopyInboxId.mockResolvedValue('inbox-1')
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
    senders.getModuleCopyInboxId.mockResolvedValue('inbox-1')
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

describe('a module naming the conversation', () => {
  const ORDER_EMAIL = { ...EMAIL, moduleName: 'shop', threadKey: 'shop-order:ord-1', subject: 'Your order DW-1 is on its way' }

  beforeEach(() => senders.getModuleCopyInboxId.mockResolvedValue('inbox-1'))

  it('starts the thread under that name the first time', async () => {
    await unifiedInboxOutboundRecord.record(ORDER_EMAIL)
    expect(db.findThreadByKey).toHaveBeenCalledWith('inbox-1', 'shop-order:ord-1')
    expect(db.createOutboundThread).toHaveBeenCalledWith(expect.objectContaining({ threadKey: 'shop-order:ord-1' }))
    expect(db.touchThread).not.toHaveBeenCalled()
  })

  it('files a later email, whatever its subject, on the thread already there', async () => {
    db.findThreadByKey.mockResolvedValue('thread-9')
    await unifiedInboxOutboundRecord.record({ ...ORDER_EMAIL, subject: 'Your delivery is booked in for Tuesday' })
    expect(db.createOutboundThread).not.toHaveBeenCalled()
    expect(db.insertOutboundMessage).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-9' }))
    expect(db.touchThread).toHaveBeenCalledWith('thread-9', expect.objectContaining({ direction: 'out', markUnread: false }))
  })

  it('opens a done or snoozed order conversation again, and says why', async () => {
    db.findThreadByKey.mockResolvedValue('thread-9')
    db.reopenOnReply.mockResolvedValue('snoozed')
    await unifiedInboxOutboundRecord.record(ORDER_EMAIL)
    expect(db.reopenOnReply).toHaveBeenCalledWith('thread-9')
    expect(db.recordEvent).toHaveBeenCalledWith('thread-9', null, 'woken', expect.objectContaining({ was: 'snoozed', cause: 'module-email' }))
  })

  it('writes no timeline line when the conversation was already open', async () => {
    db.findThreadByKey.mockResolvedValue('thread-9')
    db.reopenOnReply.mockResolvedValue(null)
    await unifiedInboxOutboundRecord.record(ORDER_EMAIL)
    expect(db.recordEvent).not.toHaveBeenCalled()
  })

  it('leaves a brand new conversation alone', async () => {
    await unifiedInboxOutboundRecord.record(ORDER_EMAIL)
    expect(db.reopenOnReply).not.toHaveBeenCalled()
  })

  it('still files a conversation each when nothing is named', async () => {
    await unifiedInboxOutboundRecord.record(EMAIL)
    expect(db.findThreadByKey).not.toHaveBeenCalled()
    expect(db.createOutboundThread).toHaveBeenCalledWith(expect.objectContaining({ threadKey: null }))
  })
})

describe('mail to our own inboxes', () => {
  it('files no sent copy, because the received one arrives by itself', async () => {
    senders.getModuleCopyInboxId.mockResolvedValue('inbox-1')
    await unifiedInboxOutboundRecord.record({ ...EMAIL, moduleName: 'shop', to: ['Purchasing@Deskwell.co.uk'] })
    expect(db.createOutboundThread).not.toHaveBeenCalled()
    expect(db.insertOutboundMessage).not.toHaveBeenCalled()
  })
})
