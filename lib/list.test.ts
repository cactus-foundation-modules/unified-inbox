import { describe, it, expect } from 'vitest'
import {
  buildSearchHref,
  channelLabel,
  chooseSendingInbox,
  formatCalendarDate,
  isSearching,
  searchRequestFrom,
  formatWhen,
  inboxHref,
  initialsFor,
  pageCount,
  parseComposeKind,
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

  it('reads the chosen tab: an id, everything, or the ones that matched nothing', () => {
    expect(parseInboxParams({ inbox: 'abc' })).toMatchObject({ inboxId: 'abc', unroutedOnly: false })
    expect(parseInboxParams({ inbox: 'all' })).toMatchObject({ inboxId: null, unroutedOnly: false })
    expect(parseInboxParams({ inbox: 'none' })).toMatchObject({ inboxId: null, unroutedOnly: true })
  })

  it('reads a channel another module owns, which takes the same slot as an address', () => {
    expect(parseInboxParams({ inbox: 'm:live-chat' })).toMatchObject({
      inboxId: null,
      providerModule: 'live-chat',
      unroutedOnly: false,
    })
    // An ordinary inbox id is not a channel, and neither is a bare prefix.
    expect(parseInboxParams({ inbox: 'abc' }).providerModule).toBeNull()
    expect(parseInboxParams({ inbox: 'm:' })).toMatchObject({ inboxId: null, providerModule: null })
  })

  it('reads the Drafts tab, which is not an inbox id', () => {
    expect(parseInboxParams({ inbox: 'drafts' })).toMatchObject({
      inboxId: null,
      draftsOnly: true,
      unroutedOnly: false,
      providerModule: null,
    })
    // An address genuinely called "drafts" would be a channel or an id; neither
    // of those is the tab.
    expect(parseInboxParams({ inbox: 'abc' }).draftsOnly).toBe(false)
    expect(parseInboxParams({}).draftsOnly).toBe(false)
  })

  it('reads the Sent tab, which is not an inbox id either', () => {
    expect(parseInboxParams({ inbox: 'sent' })).toMatchObject({
      inboxId: null,
      sentOnly: true,
      draftsOnly: false,
      unroutedOnly: false,
      providerModule: null,
    })
    expect(parseInboxParams({ inbox: 'abc' }).sentOnly).toBe(false)
    expect(parseInboxParams({}).sentOnly).toBe(false)
  })

  it('reads which draft is being finished', () => {
    expect(parseInboxParams({}).draftId).toBeNull()
    expect(parseInboxParams({ compose: '1', draft: 'dft_7' })).toMatchObject({
      composing: true,
      draftId: 'dft_7',
    })
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

// Sent, Drafts and Mentioned can each be looked at across every address or
// narrowed to one - the folders under a colleague's name on the rail. Reading
// the scoped form as an ordinary inbox id is what turns "Sam's sent post" into
// a conversation list of an address called "sent:in1".
describe('parseInboxParams, on one colleague\u2019s folders', () => {
  it('reads a scoped folder as that folder, narrowed to that address', () => {
    expect(parseInboxParams({ inbox: 'sent:in1' })).toMatchObject({
      sentOnly: true, draftsOnly: false, mentionsOnly: false,
      folderInboxId: 'in1', inboxId: null,
    })
    expect(parseInboxParams({ inbox: 'drafts:in1' })).toMatchObject({
      draftsOnly: true, sentOnly: false, folderInboxId: 'in1', inboxId: null,
    })
    expect(parseInboxParams({ inbox: 'mentions:in1' })).toMatchObject({
      mentionsOnly: true, folderInboxId: 'in1', inboxId: null,
    })
  })

  it('leaves the unscoped folders exactly as they were', () => {
    expect(parseInboxParams({ inbox: 'sent' })).toMatchObject({
      sentOnly: true, folderInboxId: null, inboxId: null,
    })
    expect(parseInboxParams({ inbox: 'mentions' })).toMatchObject({
      mentionsOnly: true, folderInboxId: null, inboxId: null,
    })
  })

  it('treats a link that lost its address as the whole folder, not as an inbox', () => {
    expect(parseInboxParams({ inbox: 'sent:' })).toMatchObject({
      sentOnly: true, folderInboxId: null, inboxId: null,
    })
  })

  it('does not mistake an ordinary address for a folder', () => {
    expect(parseInboxParams({ inbox: 'in1' })).toMatchObject({
      inboxId: 'in1', sentOnly: false, draftsOnly: false, mentionsOnly: false,
      folderInboxId: null,
    })
  })
})

describe('chooseSendingInbox', () => {
  it('writes as the inbox you are standing in', () => {
    expect(chooseSendingInbox(['a', 'b'], 'b')).toBe('b')
  })

  it('falls back to the first when the list is showing everything', () => {
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
    expect(formatWhen(new Date('2026-08-28T09:30:00Z'), now, 'Europe/London')).toMatch(/\d{2}:\d{2}/)
    expect(formatWhen(new Date('2025-01-05T09:30:00Z'), now, 'Europe/London')).toMatch(/2025/)
  })

  it('says nothing rather than "Invalid Date" for a conversation with no messages', () => {
    expect(formatWhen(null, now, 'Europe/London')).toBe('')
  })

  it('gives the time in the site timezone, not the server one', () => {
    // 09:30 UTC is half past ten in a British summer. Rendered on the server's
    // own clock this said 09:30, an hour before the message actually arrived.
    expect(formatWhen(new Date('2026-08-28T09:30:00Z'), now, 'Europe/London')).toBe('10:30')
    expect(formatWhen(new Date('2026-08-28T09:30:00Z'), now, 'UTC')).toBe('09:30')
  })

  it('counts "today" by the site calendar, so a small-hours message is not filed under yesterday', () => {
    // 23:30 UTC is already 00:30 on the 29th in London.
    const justAfterMidnight = new Date('2026-08-28T23:30:00Z')
    const londonNow = new Date('2026-08-29T08:00:00Z')
    expect(formatWhen(justAfterMidnight, londonNow, 'Europe/London')).toBe('00:30')
    // In UTC the same instant belongs to the previous day, so it reads as a weekday.
    expect(formatWhen(justAfterMidnight, londonNow, 'UTC')).toBe('Fri')
  })
})

describe('snoozeOptions', () => {
  it('offers three answers, all of them in the future', () => {
    const now = new Date('2026-08-28T15:00:00Z')
    const options = snoozeOptions(now, 'Europe/London')
    expect(options).toHaveLength(3)
    for (const option of options) expect(option.until.getTime()).toBeGreaterThan(now.getTime())
  })

  it('brings a thread back at nine in the morning here, not nine UTC', () => {
    const now = new Date('2026-08-28T15:00:00Z')
    const tomorrow = snoozeOptions(now, 'Europe/London').find((o) => o.id === 'tomorrow')!
    // 08:00 UTC is 09:00 British Summer Time.
    expect(tomorrow.until.toISOString()).toBe('2026-08-29T08:00:00.000Z')
    const week = snoozeOptions(now, 'Europe/London').find((o) => o.id === 'week')!
    expect(week.until.toISOString()).toBe('2026-09-04T08:00:00.000Z')
  })
})

describe('channelLabel', () => {
  it('says it in words a shopkeeper uses', () => {
    expect(channelLabel('email')).toBe('Email')
    expect(channelLabel('sms')).toBe('Text')
    expect(channelLabel('discussion')).toBe('Discussion')
    expect(channelLabel('carrier-pigeon')).toBe('Message')
  })
})

describe('parseComposeKind', () => {
  it('says nothing is being written when the address does not ask', () => {
    expect(parseComposeKind(undefined)).toBeNull()
    expect(parseComposeKind('')).toBeNull()
  })

  // Every link written before the menu existed says compose=1, and every one of
  // them still has to open the email composer.
  it('keeps the old flag meaning an email', () => {
    expect(parseComposeKind('1')).toBe('email')
  })

  it('reads the three the menu adds', () => {
    expect(parseComposeKind('discussion')).toBe('discussion')
    expect(parseComposeKind('sms')).toBe('sms')
    expect(parseComposeKind('call')).toBe('call')
  })

  // A value nobody wrote is a mistyped address rather than an instruction, and
  // this screen has always treated it that way.
  it('opens nothing on anything it does not know', () => {
    expect(parseComposeKind('semaphore')).toBeNull()
    expect(parseComposeKind('yes')).toBeNull()
    expect(parseComposeKind('0')).toBeNull()
  })
})

describe('parseInboxParams, on what is being written', () => {
  it('opens nothing when the address does not ask', () => {
    expect(parseInboxParams({}).composing).toBe(false)
  })

  it('opens the email composer on the old flag', () => {
    const params = parseInboxParams({ compose: '1' })
    expect(params.composing).toBe(true)
    expect(params.composeKind).toBe('email')
  })

  it('opens a discussion when asked for one', () => {
    const params = parseInboxParams({ compose: 'discussion' })
    expect(params.composing).toBe(true)
    expect(params.composeKind).toBe('discussion')
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

describe('the search dialog', () => {
  const base = '/hq/inbox'
  const carried = { tab: 'unified-inbox' }

  it('reads the narrower cuts off the address, and refuses a date that is not one', () => {
    const params = parseInboxParams({
      q: ' invoice ',
      from: ' Sally ',
      to: 'accounts@example.co.uk',
      subject: 'Chairs',
      att: '1',
      after: '2026-09-01',
      before: '2026-02-31',
    })
    expect(params).toMatchObject({
      search: 'invoice',
      fromText: 'Sally',
      toText: 'accounts@example.co.uk',
      subjectText: 'Chairs',
      withAttachment: true,
      after: '2026-09-01',
      // The 31st of February is the right shape and the wrong date, and rolling
      // it forward into March would silently answer a question nobody asked.
      before: null,
    })
  })

  it('knows the difference between a narrowed list and an empty inbox', () => {
    expect(isSearching(parseInboxParams({}))).toBe(false)
    expect(isSearching(parseInboxParams({ q: 'invoice' }))).toBe(true)
    // A date range with no words is still a search, which is what the empty
    // state has to say when it catches nothing.
    expect(isSearching(parseInboxParams({ after: '2026-09-01' }))).toBe(true)
    expect(isSearching(parseInboxParams({ att: '1' }))).toBe(true)
    // Being handed something is not searching for it.
    expect(isSearching(parseInboxParams({ assignee: 'u1' }))).toBe(false)
  })

  it('builds an address that looks everywhere and at every status', () => {
    const href = buildSearchHref(base, carried, {
      ...searchRequestFrom({}),
      q: 'invoice',
    })
    const params = new URLSearchParams(href.split('?')[1])
    expect(params.get('inbox')).toBe('all')
    expect(params.get('q')).toBe('invoice')
    expect(params.get('status')).toBe('all')
    expect(params.get('tab')).toBe('unified-inbox')
  })

  it('drops the page, the open conversation and the composer, because none of them survive a new search', () => {
    const href = buildSearchHref(
      base,
      { tab: 'unified-inbox', page: '4', id: 'thread-1', person: 'p1', compose: '1', draft: 'd1' },
      { ...searchRequestFrom({}), q: 'chairs' },
    )
    const params = new URLSearchParams(href.split('?')[1])
    for (const key of ['page', 'id', 'person', 'compose', 'draft']) {
      expect(params.get(key)).toBeNull()
    }
  })

  it('leaves open out of the address, because open is what the list shows anyway', () => {
    const href = buildSearchHref(base, carried, {
      ...searchRequestFrom({}),
      q: 'chairs',
      status: 'open',
    })
    expect(new URLSearchParams(href.split('?')[1]).get('status')).toBeNull()
  })

  it('takes only the words to the address book, since the rest are questions about post', () => {
    const href = buildSearchHref(base, carried, {
      ...searchRequestFrom({}),
      mode: 'contacts',
      q: 'Sally',
      from: 'someone',
      withAttachment: true,
      after: '2026-09-01',
    })
    const params = new URLSearchParams(href.split('?')[1])
    expect(params.get('inbox')).toBe('contacts')
    expect(params.get('q')).toBe('Sally')
    expect(params.get('from')).toBeNull()
    expect(params.get('att')).toBeNull()
    expect(params.get('after')).toBeNull()
  })

  it('opens filled in from whatever is already narrowing the list', () => {
    expect(searchRequestFrom({
      inbox: 'inbox-1', q: 'invoice', from: 'Sally', att: '1', status: 'done', unread: '1',
    })).toMatchObject({
      mode: 'conversations',
      scope: 'inbox-1',
      q: 'invoice',
      from: 'Sally',
      withAttachment: true,
      status: 'done',
      unreadOnly: true,
    })
  })

  it('opens pointed at everything when the list underneath is not a search', () => {
    // Somebody standing in one address who has come to search has usually come
    // BECAUSE the thing they want is not in it.
    expect(searchRequestFrom({ inbox: 'inbox-1' }).scope).toBe('all')
    // And keeps what they chose when they are refining the search they are
    // already looking at.
    expect(searchRequestFrom({ inbox: 'inbox-1', q: 'invoice' }).scope).toBe('inbox-1')
    expect(searchRequestFrom({ inbox: 'inbox-1', att: '1' }).scope).toBe('inbox-1')
  })

  it('points a search opened over Drafts or Sent at everything, since neither is a place to look', () => {
    const q = 'invoice'
    expect(searchRequestFrom({ inbox: 'drafts', q }).scope).toBe('all')
    expect(searchRequestFrom({ inbox: 'sent', q }).scope).toBe('all')
    expect(searchRequestFrom({ inbox: 'campaigns', q }).scope).toBe('all')
    // The address book is the one that is not a scope but IS a mode.
    expect(searchRequestFrom({ inbox: 'contacts', q })).toMatchObject({ mode: 'contacts', scope: 'all' })
    // A channel another module owns is a perfectly good place to look.
    expect(searchRequestFrom({ inbox: 'm:live-chat', q }).scope).toBe('m:live-chat')
  })

  it('writes a date the way somebody would say it, with no timezone involved', () => {
    expect(formatCalendarDate('2026-09-03')).toBe('3 Sep 2026')
    expect(formatCalendarDate('nonsense')).toBe('nonsense')
  })
})
