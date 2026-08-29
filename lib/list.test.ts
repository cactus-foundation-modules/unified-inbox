import { describe, it, expect } from 'vitest'
import {
  channelLabel,
  chooseSendingInbox,
  formatWhen,
  inboxHref,
  initialsFor,
  pageCount,
  parseInboxParams,
  participantLabel,
  quotedHtmlIndex,
  snoozeOptions,
  splitQuotedText,
} from './list'

describe('parseInboxParams', () => {
  it('opens on the open conversations with nothing selected', () => {
    const params = parseInboxParams({})
    expect(params).toMatchObject({
      inboxId: null, unroutedOnly: false, status: 'open', unreadOnly: false,
      assignee: null, search: null, page: 1, threadId: null,
    })
  })

  it('treats a mistyped page as page one rather than NaN', () => {
    expect(parseInboxParams({ page: 'banana' }).page).toBe(1)
    expect(parseInboxParams({ page: '-4' }).page).toBe(1)
    expect(parseInboxParams({ page: '3' }).page).toBe(3)
  })

  it('falls back to open on a status nobody has', () => {
    expect(parseInboxParams({ status: 'archived' }).status).toBe('open')
    expect(parseInboxParams({ status: 'done' }).status).toBe('done')
  })

  it('reads the rail: an id, everything, or the ones that matched nothing', () => {
    expect(parseInboxParams({ inbox: 'abc' })).toMatchObject({ inboxId: 'abc', unroutedOnly: false })
    expect(parseInboxParams({ inbox: 'all' })).toMatchObject({ inboxId: null, unroutedOnly: false })
    expect(parseInboxParams({ inbox: 'none' })).toMatchObject({ inboxId: null, unroutedOnly: true })
  })

  it('reads a channel another module owns, which takes the rail’s other slot', () => {
    expect(parseInboxParams({ inbox: 'm:live-chat' })).toMatchObject({
      inboxId: null,
      providerModule: 'live-chat',
      unroutedOnly: false,
    })
    // An ordinary inbox id is not a channel, and neither is a bare prefix.
    expect(parseInboxParams({ inbox: 'abc' }).providerModule).toBeNull()
    expect(parseInboxParams({ inbox: 'm:' })).toMatchObject({ inboxId: null, providerModule: null })
  })

  it('reads the compose flag, and only the one value that means it', () => {
    expect(parseInboxParams({}).composing).toBe(false)
    expect(parseInboxParams({ compose: '1' }).composing).toBe(true)
    expect(parseInboxParams({ compose: 'yes' }).composing).toBe(false)
    expect(parseInboxParams({ compose: '0' }).composing).toBe(false)
  })

  it('caps a search long enough to be an attack on the query planner', () => {
    expect(parseInboxParams({ q: 'x'.repeat(500) }).search).toHaveLength(200)
  })
})

describe('chooseSendingInbox', () => {
  it('writes as the inbox you are standing in', () => {
    expect(chooseSendingInbox(['a', 'b'], 'b')).toBe('b')
  })

  it('falls back to the first when the rail is showing everything', () => {
    expect(chooseSendingInbox(['a', 'b'], null)).toBe('a')
  })

  it('falls back rather than offering an inbox they may read but not send from', () => {
    // 'c' is on screen and visible; it is not in the sendable list, so the menu
    // must not open on it and then be refused by the send route.
    expect(chooseSendingInbox(['a', 'b'], 'c')).toBe('a')
  })

  it('has no answer when there is nothing to send from', () => {
    expect(chooseSendingInbox([], 'a')).toBeNull()
    expect(chooseSendingInbox([], null)).toBeNull()
  })
})

describe('inboxHref', () => {
  it('carries what is there and changes what it is told to', () => {
    const href = inboxHref('/hq/inbox', { tab: 'unified-inbox', status: 'open' }, { page: '2' })
    expect(href).toContain('tab=unified-inbox')
    expect(href).toContain('status=open')
    expect(href).toContain('page=2')
  })

  it('drops anything set to null, which is how a filter is cleared', () => {
    const href = inboxHref('/hq/inbox', { tab: 'unified-inbox', id: 'x' }, { id: null })
    expect(href).toBe('/hq/inbox?tab=unified-inbox')
  })
})

describe('pageCount', () => {
  it('is always at least one page, even with nothing in it', () => {
    expect(pageCount(0)).toBe(1)
    expect(pageCount(25)).toBe(1)
    expect(pageCount(26)).toBe(2)
  })
})

describe('participantLabel and initialsFor', () => {
  it('falls back through what is actually known', () => {
    expect(participantLabel({ participantName: 'Jane Smith', participantAddress: 'j@x.com' })).toBe('Jane Smith')
    expect(participantLabel({ participantName: null, participantAddress: 'j@x.com' })).toBe('j@x.com')
    expect(participantLabel({ participantName: null, participantAddress: null })).toBe('Unknown sender')
  })

  it('makes initials out of a name or an address', () => {
    expect(initialsFor('Jane Smith')).toBe('JS')
    expect(initialsFor('jane@example.com')).toBe('JE')
    expect(initialsFor('')).toBe('?')
  })
})

describe('formatWhen', () => {
  const now = new Date('2026-08-28T15:00:00Z')

  it('shows a clock for today and a date for last year', () => {
    expect(formatWhen(new Date('2026-08-28T09:30:00Z'), now)).toMatch(/\d{2}:\d{2}/)
    expect(formatWhen(new Date('2025-01-05T09:30:00Z'), now)).toMatch(/2025/)
  })

  it('says nothing rather than "Invalid Date" for a conversation with no messages', () => {
    expect(formatWhen(null, now)).toBe('')
  })
})

describe('snoozeOptions', () => {
  it('offers three answers, all of them in the future', () => {
    const now = new Date('2026-08-28T15:00:00Z')
    const options = snoozeOptions(now)
    expect(options).toHaveLength(3)
    for (const option of options) expect(option.until.getTime()).toBeGreaterThan(now.getTime())
  })
})

describe('channelLabel', () => {
  it('says it in words a shopkeeper uses', () => {
    expect(channelLabel('email')).toBe('Email')
    expect(channelLabel('sms')).toBe('Text')
    expect(channelLabel('carrier-pigeon')).toBe('Message')
  })
})

describe('splitQuotedText', () => {
  it('separates the new writing from the attribution and everything under it', () => {
    const { body, quoted } = splitQuotedText(
      'Yes, Tuesday suits.\n\nOn 3 March 2026 at 14:05, Jane wrote:\n> Are you free?',
    )
    expect(body).toBe('Yes, Tuesday suits.')
    expect(quoted).toContain('Are you free?')
  })

  it('leaves a forward with no covering note whole', () => {
    const text = 'On 3 March 2026 at 14:05, Jane wrote:\n> Are you free?'
    expect(splitQuotedText(text).quoted).toBeNull()
  })

  it('leaves an ordinary message alone', () => {
    expect(splitQuotedText('Just checking in.').quoted).toBeNull()
  })
})

describe('quotedHtmlIndex', () => {
  it('finds the earliest quote container', () => {
    const html = '<p>Yes, fine.</p><blockquote>old</blockquote>'
    expect(quotedHtmlIndex(html)).toBe(html.indexOf('<blockquote'))
  })

  it('says there is none when the whole message is a quote', () => {
    expect(quotedHtmlIndex('<blockquote>all of it</blockquote>')).toBe(-1)
  })

  it('says there is none when nothing is quoted', () => {
    expect(quotedHtmlIndex('<p>hello</p>')).toBe(-1)
  })
})
