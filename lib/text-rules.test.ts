import { describe, expect, it } from 'vitest'
import type { ConversationMessage } from '@/lib/conversations/types'
import {
  isSideText,
  isTextChannel,
  isTextMessage,
  linkSettled,
  redirectsTo,
  textableNumber,
  type TextLink,
} from './text-rules'

// Texting somebody from an email conversation: which number, which messages
// are texts, and which of them go to the email conversation.

function message(over: Partial<ConversationMessage> & Record<string, unknown> = {}): ConversationMessage {
  return {
    id: 'm1',
    direction: 'in',
    authorName: null,
    text: 'Tuesday is fine',
    html: null,
    sentAt: new Date('2026-09-20T10:00:00Z'),
    attachments: [],
    ...over,
  } as ConversationMessage
}

const LINK: TextLink = {
  phone: '+447700900123',
  threadId: 'email-thread',
  since: new Date('2026-09-20T09:00:00Z'),
  endedAt: null,
  providerModule: 'twilio',
  externalId: '+447700900123',
  seenThrough: null,
}

describe('textableNumber', () => {
  it('offers a UK mobile however it was written on the card', () => {
    expect(textableNumber(['07700 900123'], '+44')).toBe('+447700900123')
    expect(textableNumber(['+44 7700 900123'], '44')).toBe('+447700900123')
  })

  it('passes over a UK landline for the mobile beside it', () => {
    expect(textableNumber(['020 8138 0512', '07700 900123'], '+44')).toBe('+447700900123')
  })

  it('offers nothing when the card has no mobile on it', () => {
    expect(textableNumber(['020 8138 0512'], '+44')).toBeNull()
    expect(textableNumber([], '+44')).toBeNull()
    expect(textableNumber(['not a number'], '+44')).toBeNull()
  })

  it('offers any readable number on a site outside the UK, where there is no simple rule', () => {
    expect(textableNumber(['0412 345 678'], '+61')).toBe('+61412345678')
  })
})

describe('isSideText', () => {
  it('is a text sitting on an email conversation', () => {
    expect(isSideText({ channel: 'sms', direction: 'in' }, 'email')).toBe(true)
    expect(isSideText({ channel: 'sms', direction: 'out' }, 'email')).toBe(true)
  })

  it('is not the texts on a phone or text conversation, which are its own kind', () => {
    expect(isSideText({ channel: 'sms', direction: 'in' }, 'sms')).toBe(false)
    expect(isSideText({ channel: 'sms', direction: 'in' }, 'phone')).toBe(false)
  })

  it('is not an email, or a note', () => {
    expect(isSideText({ channel: 'email', direction: 'in' }, 'email')).toBe(false)
    expect(isSideText({ channel: 'sms', direction: 'note' }, 'email')).toBe(false)
  })
})

describe('isTextChannel', () => {
  it('names the two channels texts are filed under', () => {
    expect(isTextChannel('sms')).toBe(true)
    expect(isTextChannel('phone')).toBe(true)
    expect(isTextChannel('whatsapp')).toBe(false)
    expect(isTextChannel(null)).toBe(false)
  })
})

describe('isTextMessage', () => {
  it('believes the channel when it says', () => {
    expect(isTextMessage(message({ medium: 'text' }), 'phone')).toBe(true)
    expect(isTextMessage(message({ medium: 'call' }), 'phone')).toBe(false)
    expect(isTextMessage(message({ medium: 'voicemail' }), 'sms')).toBe(false)
  })

  it('reads an unmarked message by its conversation: texts alone make a text conversation', () => {
    expect(isTextMessage(message(), 'sms')).toBe(true)
    expect(isTextMessage(message(), 'phone')).toBe(false)
  })
})

describe('redirectsTo', () => {
  it('takes a text dated on or after the first one sent', () => {
    expect(redirectsTo(LINK, message({ medium: 'text' }), new Date('2026-09-20T10:00:00Z'), 'phone')).toBe(true)
    expect(redirectsTo(LINK, message({ medium: 'text' }), LINK.since, 'phone')).toBe(true)
  })

  it('leaves texts from before, calls, and everything once the note is ended', () => {
    expect(redirectsTo(LINK, message({ medium: 'text' }), new Date('2026-09-20T08:59:59Z'), 'phone')).toBe(false)
    expect(redirectsTo(LINK, message({ medium: 'call' }), new Date('2026-09-20T10:00:00Z'), 'phone')).toBe(false)
    const ended = { ...LINK, endedAt: new Date('2026-09-21T09:00:00Z') }
    expect(redirectsTo(ended, message({ medium: 'text' }), new Date('2026-09-20T10:00:00Z'), 'phone')).toBe(false)
  })
})

describe('linkSettled', () => {
  const at = new Date('2026-09-20T10:00:00Z')

  it('is never settled before the first read', () => {
    expect(linkSettled(LINK, at, at)).toBe(false)
  })

  it('is settled once read through the newest message and the newest revision', () => {
    expect(linkSettled({ ...LINK, seenThrough: at }, at, at)).toBe(true)
    const revised = new Date('2026-09-20T10:05:00Z')
    expect(linkSettled({ ...LINK, seenThrough: at }, at, revised)).toBe(false)
  })
})
