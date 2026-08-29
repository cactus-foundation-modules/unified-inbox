import { describe, it, expect } from 'vitest'
import {
  CUSTOM_TAG_HEADER,
  customTagFor,
  normaliseBrevoEvent,
  readCustomTag,
  readReadReceipt,
} from './receipts'
import { outgoingHeaders } from './compose'

// Nothing here touches a database, a mail server or Brevo. Every case below is
// a shape that has to be got right first time, because getting it wrong shows
// up as a screen that quietly says nothing rather than as an error anybody
// would notice.

describe('the tag that travels with a message', () => {
  it('goes out as JSON and comes back as the message id', () => {
    const header = customTagFor('msg-123')
    expect(readCustomTag(header)).toBe('msg-123')
  })

  it('accepts a bare id, because headers get edited by hand', () => {
    expect(readCustomTag('01J9Q2X7-message-id')).toBe('01J9Q2X7-message-id')
    // Too short to be one of ours, so it is somebody else's tag.
    expect(readCustomTag('msg-1')).toBeNull()
  })

  it('refuses somebody else’s tag', () => {
    expect(readCustomTag('order 4471 confirmation')).toBeNull()
    expect(readCustomTag('{"campaign":"spring"}')).toBeNull()
    expect(readCustomTag('{not json')).toBeNull()
    expect(readCustomTag(undefined)).toBeNull()
    expect(readCustomTag(42)).toBeNull()
  })
})

describe('normaliseBrevoEvent', () => {
  const tagged = (event: string, extra: Record<string, unknown> = {}) => ({
    event,
    email: 'customer@example.com',
    ts_event: 1_756_000_000,
    [CUSTOM_TAG_HEADER]: customTagFor('msg-1'),
    ...extra,
  })

  it('files a delivery', () => {
    const result = normaliseBrevoEvent(tagged('delivered'))
    expect(result?.messageId).toBe('msg-1')
    expect(result?.event.kind).toBe('delivered')
    expect(result?.event.occurredAt.getTime()).toBe(1_756_000_000_000)
  })

  it('treats every flavour of open as an open', () => {
    expect(normaliseBrevoEvent(tagged('opened'))?.event.kind).toBe('opened')
    expect(normaliseBrevoEvent(tagged('unique_opened'))?.event.kind).toBe('opened')
    // Brevo spells its events one way when you subscribe and another when it
    // sends them, and both have to land somewhere.
    expect(normaliseBrevoEvent(tagged('uniqueOpened'))?.event.kind).toBe('opened')
  })

  it('keeps a mail app fetching the picture apart from a person reading it', () => {
    expect(normaliseBrevoEvent(tagged('proxy_open'))?.event.kind).toBe('proxy_open')
    expect(normaliseBrevoEvent(tagged('unique_proxy_open'))?.event.kind).toBe('proxy_open')
  })

  it('files a bounce with the reason and how bad it was', () => {
    const hard = normaliseBrevoEvent(tagged('hard_bounce', { reason: 'unknown recipient' }))
    expect(hard?.event.kind).toBe('bounced')
    expect(hard?.event.bounceKind).toBe('hard')
    expect(hard?.event.detail).toBe('unknown recipient')

    expect(normaliseBrevoEvent(tagged('soft_bounce'))?.event.bounceKind).toBe('soft')
    expect(normaliseBrevoEvent(tagged('blocked'))?.event.bounceKind).toBe('blocked')
    expect(normaliseBrevoEvent(tagged('invalid_email'))?.event.bounceKind).toBe('invalid')
  })

  it('ignores everything that is not about a message of ours', () => {
    // The site’s Brevo account also carries order confirmations and password
    // resets. None of those are conversations, and filing them would be worse
    // than useless.
    expect(normaliseBrevoEvent({ event: 'delivered', email: 'a@b.com' })).toBeNull()
    expect(normaliseBrevoEvent(tagged('click'))).toBeNull()
    expect(normaliseBrevoEvent(tagged('unsubscribed'))).toBeNull()
    expect(normaliseBrevoEvent(null)).toBeNull()
    expect(normaliseBrevoEvent('delivered')).toBeNull()
  })

  it('falls back to the written date when there is no stamp', () => {
    const result = normaliseBrevoEvent({
      event: 'delivered',
      date: '2026-08-29 09:15:00',
      [CUSTOM_TAG_HEADER]: customTagFor('msg-1'),
    })
    expect(result?.event.occurredAt.getFullYear()).toBe(2026)
  })
})

describe('readReadReceipt', () => {
  const notification = [
    'Reporting-UA: Outlook',
    'Final-Recipient: rfc822;customer@example.com',
    'Original-Message-ID: <uin.abc123@deskwell.co.uk>',
    'Disposition: manual-action/MDN-sent-manually; displayed',
  ].join('\n')

  it('recognises one and names the message it is about', () => {
    const receipt = readReadReceipt({
      contentType: 'multipart/report; report-type=disposition-notification; boundary=x',
      parts: ['Your message was read.', notification],
      inReplyTo: null,
      references: [],
    })
    expect(receipt?.originalMessageId).toBe('uin.abc123@deskwell.co.uk')
    expect(receipt?.displayed).toBe(true)
  })

  it('knows the difference between read and deleted unread', () => {
    const receipt = readReadReceipt({
      contentType: 'multipart/report; report-type=disposition-notification',
      parts: [notification.replace('displayed', 'deleted')],
      inReplyTo: null,
      references: [],
    })
    expect(receipt?.displayed).toBe(false)
  })

  it('threads on the headers when the report names no original', () => {
    const receipt = readReadReceipt({
      contentType: 'multipart/report; report-type=disposition-notification',
      parts: ['Final-Recipient: rfc822;customer@example.com'],
      inReplyTo: '<uin.def456@deskwell.co.uk>',
      references: [],
    })
    expect(receipt?.originalMessageId).toBe('uin.def456@deskwell.co.uk')
  })

  it('is not fooled by an ordinary reply', () => {
    expect(readReadReceipt({
      contentType: 'multipart/alternative; boundary=x',
      parts: ['Thanks, that all looks fine to me.'],
      inReplyTo: '<uin.abc@deskwell.co.uk>',
      references: [],
    })).toBeNull()
  })

  it('gives up rather than guessing when nothing names the original', () => {
    expect(readReadReceipt({
      contentType: 'multipart/report; report-type=disposition-notification',
      parts: ['Final-Recipient: rfc822;customer@example.com'],
      inReplyTo: null,
      references: [],
    })).toBeNull()
  })
})

describe('the headers a tracked message goes out with', () => {
  it('carries neither header when the site has not asked for them', () => {
    const headers = outgoingHeaders({ messageId: 'a@b', inReplyTo: null, references: [] })
    expect(headers[CUSTOM_TAG_HEADER]).toBeUndefined()
    expect(headers['Disposition-Notification-To']).toBeUndefined()
  })

  it('carries them when it has', () => {
    const headers = outgoingHeaders({
      messageId: 'a@b',
      inReplyTo: null,
      references: [],
      trackingTag: 'msg-9',
      readReceiptTo: 'hi@deskwell.co.uk',
    })
    expect(readCustomTag(headers[CUSTOM_TAG_HEADER])).toBe('msg-9')
    expect(headers['Disposition-Notification-To']).toBe('<hi@deskwell.co.uk>')
    // The threading headers are untouched by any of it.
    expect(headers['Message-ID']).toBe('<a@b>')
  })
})
