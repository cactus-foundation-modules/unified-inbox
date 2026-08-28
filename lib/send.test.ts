import { describe, it, expect, vi, beforeEach } from 'vitest'

// Nothing in this file talks to a mail server, a database or Brevo. The point
// of the send path is the ORDER it does things in - row first, send second,
// settle third, copy to Sent last and allowed to fail - and that order is only
// observable if every one of those is a spy you can put in sequence.
//
// It is also the only responsible way to test sending. A real send from a dev
// machine reaches a real person.

const db = vi.hoisted(() => ({
  getThread: vi.fn(),
  getInbox: vi.fn(),
  listInboxes: vi.fn(),
  getQuotableMessage: vi.fn(),
  newestMessageOnThread: vi.fn(),
  createOutboundThread: vi.fn(),
  insertOutboundMessage: vi.fn(),
  insertOutboundAttachment: vi.fn(),
  settleDelivery: vi.fn(),
  recordAppendOutcome: vi.fn(),
  recordLink: vi.fn(),
  reopenForRetry: vi.fn(),
  getMessage: vi.fn(),
  listAttachmentsForMessage: vi.fn(),
}))

const transport = vi.hoisted(() => ({
  deliver: vi.fn(),
  transportForInbox: vi.fn(),
  sendingIdentity: vi.fn((inbox: { fromName: string | null; name: string; address: string }) => ({
    name: inbox.fromName ?? inbox.name,
    address: inbox.address,
  })),
}))

const append = vi.hoisted(() => ({ appendToSent: vi.fn() }))
const mime = vi.hoisted(() => ({ buildRawMessage: vi.fn() }))
const media = vi.hoisted(() => ({
  downloadMedia: vi.fn(),
  getActiveMediaProvider: vi.fn(),
  isMediaProviderConfigured: vi.fn(() => true),
}))

vi.mock('./db', () => db)
vi.mock('./transport', async () => {
  const real = await vi.importActual<typeof import('./transport')>('./transport')
  return { ...real, ...transport }
})
vi.mock('./append', () => append)
vi.mock('./mime', () => mime)
vi.mock('./attachments', () => ({ loadAttachmentBytes: vi.fn() }))
vi.mock('@/lib/media/upload', () => ({ downloadMedia: media.downloadMedia }))
vi.mock('@/lib/config/env', () => ({
  getActiveMediaProvider: media.getActiveMediaProvider,
  isMediaProviderConfigured: media.isMediaProviderConfigured,
}))

import { sendMessage, retrySend } from './send'
import { loadAttachmentBytes } from './attachments'

const INBOX = {
  id: 'inbox-1',
  name: 'Sales',
  address: 'hi@deskwell.co.uk',
  connectionId: 'conn-1',
  imapFolder: 'INBOX',
  sentFolder: 'Sent Messages',
  isCatchAll: false,
  sendTransport: 'brevo' as const,
  hasBrevoKey: false,
  smtpHost: null,
  smtpPort: null,
  smtpUsername: null,
  hasSmtpPassword: false,
  fromName: 'Deskwell',
  signatureHtml: '<p>Deskwell</p>',
  appendToSent: true,
  colour: null,
  sortOrder: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
}

const INBOUND = {
  id: 'msg-in-1',
  messageIdHeader: 'customer-1@customer.com',
  references: ['older@customer.com'],
  fromName: 'Jane Smith',
  fromAddress: 'jane@customer.com',
  replyTo: null as string | null,
  toAddresses: ['hi@deskwell.co.uk'],
  ccAddresses: ['colleague@customer.com'],
  subject: 'Chairs',
  bodyText: 'Do you have them in blue?',
  bodyHtml: '<p>Do you have them in blue?</p>',
  sentAt: new Date('2026-03-03T14:05:00Z'),
  direction: 'in' as const,
}

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    threadId: 'thread-1',
    mode: 'reply' as const,
    bodyHtml: '<p>Yes, in blue.</p>',
    idempotencyKey: 'press-of-the-button-1',
    authorUserId: 'user-1',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  db.getThread.mockResolvedValue({
    id: 'thread-1',
    inboxId: 'inbox-1',
    channel: 'email',
    subject: 'Chairs',
    subjectNormalised: 'chairs',
    status: 'open',
  })
  db.getInbox.mockResolvedValue(INBOX)
  db.listInboxes.mockResolvedValue([INBOX])
  db.newestMessageOnThread.mockResolvedValue(INBOUND)
  db.insertOutboundMessage.mockImplementation(async (data: { threadId: string }) => ({
    row: { id: 'msg-out-1', threadId: data.threadId },
    created: true,
  }))
  db.listAttachmentsForMessage.mockResolvedValue([])
  transport.deliver.mockResolvedValue({ ok: true, providerMessageId: null })
  transport.transportForInbox.mockResolvedValue(null)
  append.appendToSent.mockResolvedValue({ ok: true, folder: 'Sent Messages', uid: 42 })
  mime.buildRawMessage.mockResolvedValue(Buffer.from('raw message'))
  media.getActiveMediaProvider.mockResolvedValue('B2')
})

describe('sendMessage - the order of operations', () => {
  it('writes the row as "sending" BEFORE anything reaches the network', async () => {
    const order: string[] = []
    db.insertOutboundMessage.mockImplementation(async () => {
      order.push('row')
      return { row: { id: 'msg-out-1', threadId: 'thread-1' }, created: true }
    })
    transport.deliver.mockImplementation(async () => {
      order.push('send')
      return { ok: true, providerMessageId: null }
    })
    db.settleDelivery.mockImplementation(async () => {
      order.push('settle')
    })

    const result = await sendMessage(baseRequest())

    expect(result.ok).toBe(true)
    expect(order).toEqual(['row', 'send', 'settle'])
  })

  it('settles the row as sent once it has gone', async () => {
    await sendMessage(baseRequest())
    expect(db.settleDelivery).toHaveBeenCalledWith('msg-out-1', {
      status: 'sent',
      providerMessageId: null,
    })
  })

  it('a crash between the row and the send leaves the row behind as evidence', async () => {
    transport.deliver.mockRejectedValue(new Error('process died'))
    await expect(sendMessage(baseRequest())).rejects.toThrow()
    // The row exists and says 'sending'. Nobody has to guess afterwards whether
    // the customer got it.
    expect(db.insertOutboundMessage).toHaveBeenCalledOnce()
    expect(db.insertOutboundMessage.mock.calls[0]![0]).toMatchObject({
      threadId: 'thread-1',
      inboxId: 'inbox-1',
    })
  })
})

describe('sendMessage - idempotency (E14)', () => {
  it('a second press of the same button sends nothing', async () => {
    db.insertOutboundMessage.mockResolvedValue({
      row: { id: 'msg-out-1', threadId: 'thread-1' },
      created: false,
    })

    const result = await sendMessage(baseRequest())

    expect(result).toEqual({
      ok: true,
      messageId: 'msg-out-1',
      threadId: 'thread-1',
      alreadySent: true,
    })
    expect(transport.deliver).not.toHaveBeenCalled()
  })

  it('carries the caller token onto the row, which is what makes that possible', async () => {
    await sendMessage(baseRequest({ idempotencyKey: 'token-abc-123' }))
    expect(db.insertOutboundMessage.mock.calls[0]![0].idempotencyKey).toBe('token-abc-123')
  })
})

describe('sendMessage - headers (E11, and what S5/S7 depend on)', () => {
  it('sets our own Message-ID, stored without brackets and sent with them', async () => {
    await sendMessage(baseRequest())

    const stored = db.insertOutboundMessage.mock.calls[0]![0].messageIdHeader as string
    const sent = transport.deliver.mock.calls[0]![0].headers as Record<string, string>

    expect(stored).not.toMatch(/^</)
    expect(stored).toMatch(/@deskwell\.co\.uk$/)
    expect(sent['Message-ID']).toBe(`<${stored}>`)
  })

  it('threads the reply back to what it answers', async () => {
    await sendMessage(baseRequest())
    const sent = transport.deliver.mock.calls[0]![0].headers as Record<string, string>

    expect(sent['In-Reply-To']).toBe('<customer-1@customer.com>')
    expect(sent['References']).toBe('<older@customer.com> <customer-1@customer.com>')
  })

  it('emits nothing beyond those three', async () => {
    await sendMessage(baseRequest())
    const sent = transport.deliver.mock.calls[0]![0].headers as Record<string, string>
    expect(Object.keys(sent).sort()).toEqual(['In-Reply-To', 'Message-ID', 'References'])
  })

  it('the copy filed in Sent carries the SAME Message-ID, which is what stops the loop', async () => {
    await sendMessage(baseRequest())

    const stored = db.insertOutboundMessage.mock.calls[0]![0].messageIdHeader as string
    const raw = mime.buildRawMessage.mock.calls[0]![0] as { headers: Record<string, string> }

    expect(raw.headers['Message-ID']).toBe(`<${stored}>`)
  })
})

describe('sendMessage - the sending identity (D3)', () => {
  it('goes out AS the inbox that is answering, not as the site', async () => {
    await sendMessage(baseRequest())
    expect(transport.deliver.mock.calls[0]![0].from).toEqual({
      name: 'Deskwell',
      address: 'hi@deskwell.co.uk',
    })
  })

  it('a second inbox answers as itself, which is the entire point', async () => {
    db.getInbox.mockResolvedValue({
      ...INBOX,
      id: 'inbox-2',
      name: 'Purchasing',
      address: 'marcus@deskwell.co.uk',
      fromName: 'Marcus at Deskwell',
    })

    await sendMessage(baseRequest())

    expect(transport.deliver.mock.calls[0]![0].from).toEqual({
      name: 'Marcus at Deskwell',
      address: 'marcus@deskwell.co.uk',
    })
  })

  it('stores the same address on the row that it sent under', async () => {
    await sendMessage(baseRequest())
    expect(db.insertOutboundMessage.mock.calls[0]![0].fromAddress).toBe('hi@deskwell.co.uk')
  })

  it('uses the site account when the inbox has none of its own', async () => {
    await sendMessage(baseRequest())
    expect(transport.deliver.mock.calls[0]![0].transport).toBeNull()
  })

  it('uses the inbox own account when it has one', async () => {
    transport.transportForInbox.mockResolvedValue({ provider: 'brevo', apiKey: 'inbox-key' })
    await sendMessage(baseRequest())
    expect(transport.deliver.mock.calls[0]![0].transport).toEqual({
      provider: 'brevo',
      apiKey: 'inbox-key',
    })
  })

  it('still sets Reply-To, so an answer comes back here even if a server rewrites the sender', async () => {
    await sendMessage(baseRequest())
    expect(transport.deliver.mock.calls[0]![0].replyTo).toBe('hi@deskwell.co.uk')
  })
})

describe('sendMessage - recipients', () => {
  it('answers Reply-To rather than From when the sender set one (E13)', async () => {
    db.newestMessageOnThread.mockResolvedValue({ ...INBOUND, replyTo: 'sales@customer.com' })
    await sendMessage(baseRequest())
    expect(transport.deliver.mock.calls[0]![0].to).toEqual(['sales@customer.com'])
  })

  it('reply-all keeps the others and never copies us back in', async () => {
    await sendMessage(baseRequest({ mode: 'reply-all' }))
    const sent = transport.deliver.mock.calls[0]![0]
    expect(sent.to).toEqual(['jane@customer.com'])
    expect(sent.cc).toEqual(['colleague@customer.com'])
  })

  it('refuses rather than sending into the dark when there is nobody to answer', async () => {
    db.newestMessageOnThread.mockResolvedValue({ ...INBOUND, fromAddress: null, replyTo: null })
    const result = await sendMessage(baseRequest())
    expect(result).toEqual({ ok: false, reason: 'There is nobody to send this to. Add an address.' })
    expect(db.insertOutboundMessage).not.toHaveBeenCalled()
    expect(transport.deliver).not.toHaveBeenCalled()
  })

  it('a forward goes out as the inbox, not as whoever wrote the original (E12)', async () => {
    const result = await sendMessage(
      baseRequest({ mode: 'forward', to: ['supplier@example.com'] }),
    )
    expect(result.ok).toBe(true)

    const row = db.insertOutboundMessage.mock.calls[0]![0]
    expect(row.fromAddress).toBe('hi@deskwell.co.uk')
    expect(row.fromAddress).not.toBe('jane@customer.com')

    const raw = mime.buildRawMessage.mock.calls[0]![0] as { from: { address: string } }
    expect(raw.from.address).toBe('hi@deskwell.co.uk')

    // The original sender is reproduced in the body instead, where it belongs.
    expect(row.bodyHtml).toContain('jane@customer.com')
    expect(row.subject).toBe('Fwd: Chairs')
  })
})

describe('sendMessage - failure (no silent failures anywhere)', () => {
  it('records the failure on the message and hands back a sentence, not a stack trace', async () => {
    transport.deliver.mockResolvedValue({
      ok: false,
      error: 'Brevo will not send from that address yet.',
    })

    const result = await sendMessage(baseRequest())

    expect(result).toEqual({ ok: false, reason: 'Brevo will not send from that address yet.' })
    expect(db.settleDelivery).toHaveBeenCalledWith('msg-out-1', {
      status: 'failed',
      error: 'Brevo will not send from that address yet.',
    })
  })

  it('does not file a copy in Sent for a message that never went', async () => {
    transport.deliver.mockResolvedValue({ ok: false, error: 'nope' })
    await sendMessage(baseRequest())
    expect(append.appendToSent).not.toHaveBeenCalled()
  })
})

describe('sendMessage - the copy in Sent is allowed to fail (D4)', () => {
  it('a failed copy is still a successful send', async () => {
    append.appendToSent.mockResolvedValue({
      ok: false,
      reason: 'The mail account was busy collecting messages.',
    })

    const result = await sendMessage(baseRequest())

    expect(result.ok).toBe(true)
    expect(db.recordAppendOutcome).toHaveBeenCalledWith('msg-out-1', {
      status: 'failed',
      error: 'The mail account was busy collecting messages.',
    })
    expect(db.settleDelivery).toHaveBeenCalledWith('msg-out-1', {
      status: 'sent',
      providerMessageId: null,
    })
  })

  it('an exception building the copy does not escape either', async () => {
    mime.buildRawMessage.mockRejectedValue(new Error('MIME exploded'))
    const result = await sendMessage(baseRequest())
    expect(result.ok).toBe(true)
    expect(db.recordAppendOutcome).toHaveBeenCalledWith('msg-out-1', {
      status: 'failed',
      error: 'MIME exploded',
    })
  })

  it('does not touch the mailbox at all when the inbox has not asked for it', async () => {
    db.getInbox.mockResolvedValue({ ...INBOX, appendToSent: false })
    const result = await sendMessage(baseRequest())
    expect(result.ok).toBe(true)
    expect(append.appendToSent).not.toHaveBeenCalled()
    expect(db.recordAppendOutcome).toHaveBeenCalledWith('msg-out-1', { status: 'skipped' })
  })

  it('records where the copy landed so the sync engine has it for free', async () => {
    await sendMessage(baseRequest())
    expect(db.recordAppendOutcome).toHaveBeenCalledWith('msg-out-1', {
      status: 'appended',
      folder: 'Sent Messages',
      uid: 42,
    })
  })
})

describe('sendMessage - attachments are never silently dropped (5.2)', () => {
  it('refuses an oversized file before a row is written or anything is sent', async () => {
    media.downloadMedia.mockResolvedValue(Buffer.alloc(9 * 1024 * 1024))

    const result = await sendMessage(
      baseRequest({
        attachments: [
          { key: 'k', url: 'https://cdn/x', filename: 'catalogue.pdf', contentType: 'application/pdf' },
        ],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.reason).toContain('catalogue.pdf')
    expect(db.insertOutboundMessage).not.toHaveBeenCalled()
    expect(transport.deliver).not.toHaveBeenCalled()
  })

  it('refuses rather than sending without a file it could not read', async () => {
    media.downloadMedia.mockRejectedValue(new Error('gone'))

    const result = await sendMessage(
      baseRequest({
        attachments: [{ key: 'k', url: 'https://cdn/x', filename: 'quote.pdf', contentType: null }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.reason).toContain('quote.pdf')
    expect(transport.deliver).not.toHaveBeenCalled()
  })

  it('sends a sensible one and records it against the message', async () => {
    media.downloadMedia.mockResolvedValue(Buffer.alloc(1024))

    const result = await sendMessage(
      baseRequest({
        attachments: [
          { key: 'media/quote.pdf', url: 'https://cdn/quote.pdf', filename: 'quote.pdf', contentType: 'application/pdf' },
        ],
      }),
    )

    expect(result.ok).toBe(true)
    expect(transport.deliver.mock.calls[0]![0].attachments).toHaveLength(1)
    expect(db.insertOutboundAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'quote.pdf', mediaKey: 'media/quote.pdf', sizeBytes: 1024 }),
    )
  })

  it('carries the original attachments on a forward, and refuses if one cannot be fetched', async () => {
    db.listAttachmentsForMessage.mockResolvedValue([
      { id: 'att-1', filename: 'invoice.pdf', mediaKey: null, mediaProvider: null, mediaUrl: null },
    ])
    vi.mocked(loadAttachmentBytes).mockResolvedValue({
      ok: false,
      reason: 'The message is no longer on the mail server.',
      status: 404,
    })

    const result = await sendMessage(
      baseRequest({
        mode: 'forward',
        to: ['supplier@example.com'],
        includeOriginalAttachments: true,
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.reason).toContain('invoice.pdf')
    expect(transport.deliver).not.toHaveBeenCalled()
  })
})

describe('sendMessage - starting a conversation (D12)', () => {
  it('opens a thread and links it to the record it is about', async () => {
    db.createOutboundThread.mockResolvedValue('thread-new')

    const result = await sendMessage({
      inboxId: 'inbox-1',
      mode: 'new',
      to: ['supplier@example.com'],
      subject: 'PO-1234',
      bodyHtml: '<p>Order attached.</p>',
      idempotencyKey: 'press-1',
      authorUserId: 'user-1',
      link: {
        moduleName: 'purchase-orders',
        recordType: 'purchase-order',
        recordId: 'po-1234',
        label: 'PO-1234',
      },
    })

    expect(result.ok).toBe(true)
    expect(db.createOutboundThread).toHaveBeenCalledOnce()
    expect(db.recordLink).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-new',
        moduleName: 'purchase-orders',
        recordId: 'po-1234',
        linkedBy: 'user',
      }),
    )
  })

  it('insists on a subject rather than sending a blank one', async () => {
    const result = await sendMessage({
      inboxId: 'inbox-1',
      mode: 'new',
      to: ['supplier@example.com'],
      bodyHtml: '<p>Hello</p>',
      idempotencyKey: 'press-1',
      authorUserId: 'user-1',
    })
    expect(result).toEqual({ ok: false, reason: 'Give the message a subject.' })
  })
})

describe('retrySend', () => {
  const FAILED = {
    id: 'msg-out-1',
    threadId: 'thread-1',
    inboxId: 'inbox-1',
    direction: 'out' as const,
    messageIdHeader: 'uin.abc@deskwell.co.uk',
    deliveryStatus: 'failed',
    toAddresses: ['jane@customer.com'],
    ccAddresses: [],
    subject: 'Re: Chairs',
    bodyHtml: '<p>Yes, in blue.</p>',
    bodyText: 'Yes, in blue.',
  }

  beforeEach(() => {
    db.getMessage.mockResolvedValue(FAILED)
    db.getQuotableMessage.mockResolvedValue({
      ...FAILED,
      references: ['older@customer.com', 'customer-1@customer.com'],
      sentAt: new Date(),
    })
    db.reopenForRetry.mockResolvedValue(true)
  })

  it('goes out under the same identity the first attempt used', async () => {
    await retrySend('msg-out-1')
    expect(transport.deliver.mock.calls[0]![0].from).toEqual({
      name: 'Deskwell',
      address: 'hi@deskwell.co.uk',
    })
  })

  it('reuses the same Message-ID, so it is one message having another go', async () => {
    const result = await retrySend('msg-out-1')
    expect(result.ok).toBe(true)
    const sent = transport.deliver.mock.calls[0]![0].headers as Record<string, string>
    expect(sent['Message-ID']).toBe('<uin.abc@deskwell.co.uk>')
  })

  it('keeps the conversation it belonged to', async () => {
    await retrySend('msg-out-1')
    const sent = transport.deliver.mock.calls[0]![0].headers as Record<string, string>
    expect(sent['References']).toBe('<older@customer.com> <customer-1@customer.com>')
    expect(sent['In-Reply-To']).toBe('<customer-1@customer.com>')
  })

  it('refuses to race a send that may still be in flight', async () => {
    db.reopenForRetry.mockResolvedValue(false)
    const result = await retrySend('msg-out-1')
    expect(result.ok).toBe(false)
    expect(transport.deliver).not.toHaveBeenCalled()
  })

  it('does not send a message that already went', async () => {
    db.getMessage.mockResolvedValue({ ...FAILED, deliveryStatus: 'sent' })
    const result = await retrySend('msg-out-1')
    expect(result).toEqual({
      ok: true,
      messageId: 'msg-out-1',
      threadId: 'thread-1',
      alreadySent: true,
    })
    expect(transport.deliver).not.toHaveBeenCalled()
  })

  it('settles it again when the second go fails too', async () => {
    transport.deliver.mockResolvedValue({ ok: false, error: 'still no' })
    const result = await retrySend('msg-out-1')
    expect(result).toEqual({ ok: false, reason: 'still no' })
    expect(db.settleDelivery).toHaveBeenCalledWith('msg-out-1', {
      status: 'failed',
      error: 'still no',
    })
  })
})
