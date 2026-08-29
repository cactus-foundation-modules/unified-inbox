import { describe, it, expect } from 'vitest'
import {
  addressDomain,
  isValidAddress,
  normaliseAddress,
  parseAddressList,
  routeSentToInbox,
  routeToInbox,
  shouldDiscardUnrouted,
} from './addresses'

describe('normaliseAddress', () => {
  it('strips a display name and the angle brackets round the address', () => {
    expect(normaliseAddress('"Brown, Marcus" <Marcus@Deskwell.co.uk>')).toBe('marcus@deskwell.co.uk')
  })

  it('lower-cases a bare address', () => {
    expect(normaliseAddress('  HI@Deskwell.CO.UK ')).toBe('hi@deskwell.co.uk')
  })
})

describe('parseAddressList', () => {
  it('splits several addresses', () => {
    expect(parseAddressList('hi@a.com, Marcus <marcus@b.com>')).toEqual(['hi@a.com', 'marcus@b.com'])
  })

  it('does not split on a comma inside a quoted display name', () => {
    expect(parseAddressList('"Brown, Marcus" <marcus@b.com>, hi@a.com'))
      .toEqual(['marcus@b.com', 'hi@a.com'])
  })

  it('treats nothing as no addresses', () => {
    expect(parseAddressList(null)).toEqual([])
    expect(parseAddressList('')).toEqual([])
  })
})

describe('addressDomain', () => {
  it('reads the domain', () => {
    expect(addressDomain('Marcus@Deskwell.co.uk')).toBe('deskwell.co.uk')
  })

  it('gives nothing back for something that is not an address', () => {
    expect(addressDomain('marcus')).toBeNull()
    expect(addressDomain('@deskwell.co.uk')).toBeNull()
  })
})

describe('isValidAddress', () => {
  it('accepts an ordinary address', () => {
    expect(isValidAddress('hi@deskwell.co.uk')).toBe(true)
  })

  it('rejects the near misses', () => {
    expect(isValidAddress('hi@deskwell')).toBe(false)
    expect(isValidAddress('hi deskwell.co.uk')).toBe(false)
    expect(isValidAddress('@deskwell.co.uk')).toBe(false)
  })
})

describe('routeToInbox', () => {
  const inboxes = [
    { id: 'hi', address: 'hi@deskwell.co.uk', isCatchAll: false },
    { id: 'marcus', address: 'marcus@deskwell.co.uk', isCatchAll: false },
    { id: 'general', address: 'general@deskwell.co.uk', isCatchAll: true },
  ]

  it('prefers the delivered-to address over the To line', () => {
    expect(routeToInbox({
      deliveredTo: ['marcus@deskwell.co.uk'],
      to: ['hi@deskwell.co.uk'],
    }, inboxes)).toEqual({ inboxId: 'marcus', matchedOn: 'delivered-to' })
  })

  it('falls back to To, then Cc', () => {
    expect(routeToInbox({ to: ['hi@deskwell.co.uk'] }, inboxes))
      .toEqual({ inboxId: 'hi', matchedOn: 'to' })
    expect(routeToInbox({ to: ['someone@else.com'], cc: ['marcus@deskwell.co.uk'] }, inboxes))
      .toEqual({ inboxId: 'marcus', matchedOn: 'cc' })
  })

  it('ignores case and display names in the headers', () => {
    expect(routeToInbox({ deliveredTo: ['"Sales" <HI@Deskwell.CO.UK>'] }, inboxes))
      .toEqual({ inboxId: 'hi', matchedOn: 'delivered-to' })
  })

  it('sends anything unmatched to the catch-all', () => {
    expect(routeToInbox({ to: ['nobody@elsewhere.com'] }, inboxes))
      .toEqual({ inboxId: 'general', matchedOn: 'catch-all' })
  })

  it('says so plainly when there is no catch-all to fall back on', () => {
    expect(routeToInbox({ to: ['nobody@elsewhere.com'] }, inboxes.slice(0, 2)))
      .toEqual({ inboxId: null, matchedOn: 'none' })
  })
})

describe('routeSentToInbox', () => {
  const inboxes = [
    { id: 'hi', address: 'hi@deskwell.co.uk', isCatchAll: true },
    { id: 'marcus', address: 'marcus@deskwell.co.uk', isCatchAll: false },
  ]

  it('files our own sent mail under the address it was sent as', () => {
    // The recipient is a customer and matches no inbox at all, so the From line
    // is the only thing that can say which conversation this belongs to.
    expect(routeSentToInbox(['marcus@deskwell.co.uk'], { to: ['customer@example.com'] }, inboxes))
      .toEqual({ inboxId: 'marcus', matchedOn: 'from' })
  })

  it('is not fooled by the case somebody typed', () => {
    expect(routeSentToInbox(['Marcus@Deskwell.co.uk'], { to: ['customer@example.com'] }, inboxes).inboxId)
      .toBe('marcus')
  })

  it('falls back to the ordinary rules when it was sent from an address we do not serve', () => {
    expect(routeSentToInbox(['personal@example.com'], { to: ['marcus@deskwell.co.uk'] }, inboxes))
      .toEqual({ inboxId: 'marcus', matchedOn: 'to' })
  })

  it('lands in the catch-all when nothing else claims it', () => {
    expect(routeSentToInbox(['personal@example.com'], { to: ['nobody@example.com'] }, inboxes))
      .toEqual({ inboxId: 'hi', matchedOn: 'catch-all' })
  })
})

describe('shouldDiscardUnrouted', () => {
  it('keeps everything while the account has not been told otherwise', () => {
    // The default, and the only acceptable one for a setting about somebody's
    // mail: an install updating into this column behaves as it did yesterday.
    expect(shouldDiscardUnrouted({ enabled: false, inboxId: null, threadId: null })).toBe(false)
  })

  it('drops a new conversation addressed to none of our addresses', () => {
    // The case the setting exists for: a personal account whose INBOX carries
    // the owner's bank, doctor and credit agency alongside the shop's mail.
    expect(shouldDiscardUnrouted({ enabled: true, inboxId: null, threadId: null })).toBe(true)
  })

  it('keeps a message that routes nowhere but joins a conversation we hold', () => {
    // A third party brought in halfway, or an address that appears only in a
    // Bcc. Dropping these leaves a thread reading as though somebody stopped
    // replying.
    expect(shouldDiscardUnrouted({ enabled: true, inboxId: null, threadId: 'thread-1' })).toBe(false)
  })

  it('never touches mail that reached one of our addresses', () => {
    expect(shouldDiscardUnrouted({ enabled: true, inboxId: 'marcus', threadId: null })).toBe(false)
  })
})
