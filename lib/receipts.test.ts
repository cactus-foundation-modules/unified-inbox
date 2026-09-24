import { describe, it, expect } from 'vitest'
import {
  CUSTOM_TAG_HEADER,
  customTagFor,
  mergeDeliveryHistory,
  normaliseBrevoEvent,
  normaliseBrevoReportEvent,
  readCustomTag,
  readReadReceipt,
} from './receipts'
import type { ReportedDeliveryEvent, StoredDeliveryEvent } from './receipts'
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

  it('files a click and keeps the address that was followed', () => {
    const result = normaliseBrevoEvent(tagged('click', { link: 'https://example.co.uk/quote/1' }))
    expect(result?.event.kind).toBe('clicked')
    expect(result?.event.detail).toBe('https://example.co.uk/quote/1')
    // The campaign half of Brevo spells the same field differently.
    expect(normaliseBrevoEvent(tagged('click', { URL: 'https://example.co.uk/chairs' }))?.event.detail)
      .toBe('https://example.co.uk/chairs')
  })

  it('files a click that names no address rather than dropping it', () => {
    // The count still means something without the link, and an event thrown
    // away is an event nobody can ever get back.
    const result = normaliseBrevoEvent(tagged('click'))
    expect(result?.event.kind).toBe('clicked')
    expect(result?.event.detail).toBeNull()
  })

  it('will not put anything but a web address on the screen', () => {
    // It ends up in a tooltip in the admin, so a javascript: link arriving in
    // somebody else's payload is not something to store and show.
    expect(normaliseBrevoEvent(tagged('click', { link: 'javascript:alert(1)' }))?.event.detail).toBeNull()
    expect(normaliseBrevoEvent(tagged('click', { link: 'mailto:someone@example.com' }))?.event.detail).toBeNull()
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

  it('ignores everything that names no message and everything we have no opinion on', () => {
    // An event carrying neither our tag nor the service’s own id cannot be
    // about anything, and a kind we do not file is not worth a lookup.
    expect(normaliseBrevoEvent({ event: 'delivered', email: 'a@b.com' })).toBeNull()
    expect(normaliseBrevoEvent(tagged('unsubscribed'))).toBeNull()
    expect(normaliseBrevoEvent(tagged('request'))).toBeNull()
    expect(normaliseBrevoEvent(null)).toBeNull()
    expect(normaliseBrevoEvent('delivered')).toBeNull()
  })

  it('hands back the service’s own id when our tag never went out', () => {
    // An order confirmation. The shop sent it and this module was given a copy
    // afterwards, so there was no tag to put on it - and until this, every
    // event about one was dropped here and the conversation showed nothing.
    const result = normaliseBrevoEvent({
      event: 'click',
      email: 'customer@example.com',
      ts_event: 1_756_000_000,
      'message-id': '<202609091254.15483442510@smtp-relay.mailin.fr>',
      link: 'https://example.com/orders/DW000182',
    })
    expect(result?.messageId).toBeNull()
    // Brackets off, because that is how the id is stored on the row and the two
    // have to compare equal.
    expect(result?.providerMessageId).toBe('202609091254.15483442510@smtp-relay.mailin.fr')
    expect(result?.event.kind).toBe('clicked')
    expect(result?.event.detail).toBe('https://example.com/orders/DW000182')
  })

  it('keeps both handles when both arrived', () => {
    const result = normaliseBrevoEvent(tagged('delivered', { 'message-id': '<abc@smtp-relay.mailin.fr>' }))
    expect(result?.messageId).toBe('msg-1')
    expect(result?.providerMessageId).toBe('abc@smtp-relay.mailin.fr')
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

describe('normaliseBrevoReportEvent', () => {
  it('reads a row of the event report in our terms, address and all', () => {
    const row = normaliseBrevoReportEvent({
      email: 'customer@example.com',
      date: '2026-09-22T13:09:41.000Z',
      event: 'opened',
      messageId: '<abc@deskwell.example>',
      ip: '172.186.8.69',
    })
    expect(row?.kind).toBe('opened')
    expect(row?.ip).toBe('172.186.8.69')
    expect(row?.occurredAt.toISOString()).toBe('2026-09-22T13:09:41.000Z')
  })

  it('knows the report’s own names for things', () => {
    expect(normaliseBrevoReportEvent({ event: 'requests', date: '2026-09-22 13:09:00' })?.kind).toBe('sent')
    expect(normaliseBrevoReportEvent({ event: 'loadedByProxy', date: '2026-09-22 13:09:00' })?.kind).toBe('proxy_open')
    expect(normaliseBrevoReportEvent({ event: 'clicks', date: '2026-09-22 13:09:00', link: 'https://example.co.uk/q' })?.detail)
      .toBe('https://example.co.uk/q')
    const bounce = normaliseBrevoReportEvent({ event: 'hardBounces', date: '2026-09-22 13:09:00', reason: 'no such user' })
    expect(bounce?.kind).toBe('bounced')
    expect(bounce?.bounceKind).toBe('hard')
    expect(bounce?.detail).toBe('no such user')
  })

  it('will not put anything but an address in the address column', () => {
    expect(normaliseBrevoReportEvent({ event: 'opened', date: '2026-09-22 13:09:00', ip: '<script>' })?.ip).toBeNull()
    expect(normaliseBrevoReportEvent({ event: 'opened', date: '2026-09-22 13:09:00', ip: '999.1.1.1' })?.ip).toBeNull()
    expect(normaliseBrevoReportEvent({ event: 'opened', date: '2026-09-22 13:09:00', ip: '2A02:C7C:1::1' })?.ip).toBe('2a02:c7c:1::1')
  })

  it('drops what it cannot place or has no opinion on', () => {
    expect(normaliseBrevoReportEvent({ event: 'unsubscribed', date: '2026-09-22 13:09:00' })).toBeNull()
    expect(normaliseBrevoReportEvent({ event: 'opened' })).toBeNull()
    expect(normaliseBrevoReportEvent({ event: 'opened', date: 'yesterday-ish' })).toBeNull()
    expect(normaliseBrevoReportEvent(null)).toBeNull()
  })
})

describe('mergeDeliveryHistory', () => {
  const at = (iso: string) => new Date(iso)
  const stored = (over: Partial<StoredDeliveryEvent> & { id: string; kind: string; occurredAt: Date }): StoredDeliveryEvent => ({
    source: 'brevo', detail: null, ip: null, userAgent: null, ...over,
  })
  const reported = (over: Partial<ReportedDeliveryEvent> & { kind: ReportedDeliveryEvent['kind']; occurredAt: Date }): ReportedDeliveryEvent => ({
    detail: null, bounceKind: null, ip: null, ...over,
  })

  it('shows one line for an event both sides know, with the address the report knew', () => {
    const { events, learnedIps } = mergeDeliveryHistory(
      [stored({ id: 'row-1', kind: 'opened', occurredAt: at('2026-09-22T13:09:44Z'), userAgent: 'Outlook' })],
      [reported({ kind: 'opened', occurredAt: at('2026-09-22T13:09:41Z'), ip: '172.186.8.69' })],
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ id: 'row-1', ip: '172.186.8.69', userAgent: 'Outlook' })
    // The ledger's own stamp wins: it is the one the labels were built from.
    expect(events[0]!.occurredAt.toISOString()).toBe('2026-09-22T13:09:44.000Z')
    expect(learnedIps).toEqual([{ id: 'row-1', ip: '172.186.8.69' }])
  })

  it('keeps an address the ledger already had rather than learning it twice', () => {
    const { events, learnedIps } = mergeDeliveryHistory(
      [stored({ id: 'row-1', kind: 'opened', occurredAt: at('2026-09-22T13:09:44Z'), ip: '10.0.0.1' })],
      [reported({ kind: 'opened', occurredAt: at('2026-09-22T13:09:41Z'), ip: '172.186.8.69' })],
    )
    expect(events[0]!.ip).toBe('10.0.0.1')
    expect(learnedIps).toEqual([])
  })

  it('shows what only one side knows, and puts everything in order', () => {
    const { events } = mergeDeliveryHistory(
      [
        stored({ id: 'row-1', kind: 'delivered', occurredAt: at('2026-09-22T13:09:30Z') }),
        stored({ id: 'row-2', kind: 'receipt', source: 'receipt', occurredAt: at('2026-09-22T15:00:00Z') }),
      ],
      [
        reported({ kind: 'sent', occurredAt: at('2026-09-22T13:09:28Z'), ip: '77.32.148.26' }),
        reported({ kind: 'delivered', occurredAt: at('2026-09-22T13:09:31Z'), ip: '77.32.148.26' }),
      ],
    )
    expect(events.map((e) => e.kind)).toEqual(['sent', 'delivered', 'receipt'])
    expect(events[0]!.id).toBeNull()
    expect(events[1]).toMatchObject({ id: 'row-1', ip: '77.32.148.26' })
    expect(events[2]).toMatchObject({ id: 'row-2', source: 'receipt' })
  })

  it('does not fold two genuine opens into one, and pairs each with its nearest', () => {
    const { events } = mergeDeliveryHistory(
      [
        stored({ id: 'row-1', kind: 'opened', occurredAt: at('2026-09-22T13:10:00Z') }),
        stored({ id: 'row-2', kind: 'opened', occurredAt: at('2026-09-22T13:10:40Z') }),
      ],
      [
        reported({ kind: 'opened', occurredAt: at('2026-09-22T13:10:38Z'), ip: '2.2.2.2' }),
        reported({ kind: 'opened', occurredAt: at('2026-09-22T13:09:59Z'), ip: '1.1.1.1' }),
      ],
    )
    expect(events).toHaveLength(2)
    expect(events.find((e) => e.id === 'row-1')?.ip).toBe('1.1.1.1')
    expect(events.find((e) => e.id === 'row-2')?.ip).toBe('2.2.2.2')
  })

  it('treats two clicks on different links in the same second as two clicks', () => {
    const { events } = mergeDeliveryHistory(
      [stored({ id: 'row-1', kind: 'clicked', detail: 'https://example.co.uk/a', occurredAt: at('2026-09-22T13:10:00Z') })],
      [
        reported({ kind: 'clicked', detail: 'https://example.co.uk/b', occurredAt: at('2026-09-22T13:10:00Z'), ip: '3.3.3.3' }),
        reported({ kind: 'clicked', detail: 'https://example.co.uk/a', occurredAt: at('2026-09-22T13:10:00Z'), ip: '3.3.3.3' }),
      ],
    )
    expect(events).toHaveLength(2)
    expect(events.find((e) => e.id === 'row-1')?.ip).toBe('3.3.3.3')
    expect(events.find((e) => e.id === null)?.detail).toBe('https://example.co.uk/b')
  })

  it('remembers the program that fetched it when the webhook said', () => {
    const one = normaliseBrevoEvent({
      event: 'opened',
      email: 'customer@example.com',
      ts_event: 1_756_000_000,
      user_agent: 'Mozilla/5.0 (Windows NT 10.0) Outlook',
      sending_ip: '77.32.148.26',
      [CUSTOM_TAG_HEADER]: customTagFor('msg-1'),
    })
    expect(one?.event.userAgent).toBe('Mozilla/5.0 (Windows NT 10.0) Outlook')
  })
})
