import { describe, it, expect } from 'vitest'
import {
  CONSUMER_DOMAINS,
  displayNameFor,
  domainOf,
  identityKey,
  isOwnSender,
  isPersonalDomain,
  organisationNameFromDomain,
  phoneKey,
  preferContactName,
  tidyPhone,
  resolveOwnDomains,
  shouldBecomePerson,
} from './people'

const gate = (over: Partial<Parameters<typeof shouldBecomePerson>[1]> = {}) => ({
  ownAddresses: new Set<string>(),
  staffAddresses: new Set<string>(),
  ownDomains: [] as string[],
  ...over,
})

describe('identityKey', () => {
  it('lower cases and strips a plus tag for matching', () => {
    expect(identityKey('Jane.Smith+shop@Example.COM')).toBe('jane.smith@example.com')
  })

  it('keeps a local part that merely contains no plus', () => {
    expect(identityKey('jane@example.com')).toBe('jane@example.com')
  })

  it('refuses anything that is not an address', () => {
    expect(identityKey('not an address')).toBeNull()
    expect(identityKey('@example.com')).toBeNull()
    expect(identityKey('jane@')).toBeNull()
    expect(identityKey(null)).toBeNull()
  })

  it('keeps a plus that starts the local part, because that is the address', () => {
    // A local part beginning with a plus is a whole address, not a tag on an
    // empty one. Stripping it would leave nothing to match on.
    expect(identityKey('+tag@example.com')).toBe('+tag@example.com')
  })
})

describe('tidyPhone and phoneKey', () => {
  it('reduces a number written several ways to one identity', () => {
    expect(phoneKey('01234 567 890', '+44')).toBe('01234567890')
    expect(phoneKey('(01234) 567890', '+44')).toBe('01234567890')
  })

  it('writes the site\'s own country nationally, without spaces', () => {
    for (const typed of ['+447311351565', '+44 7311 351565', '0044 7311 351565', '+44 (0)7311 351565', '07311 351565']) {
      expect(tidyPhone(typed, '+44')).toBe('07311351565')
    }
  })

  it('keeps the country code on a number from somewhere else', () => {
    expect(tidyPhone('+33 1 23 45 67 89', '+44')).toBe('+33123456789')
    expect(tidyPhone('+44 7311 351565', '+33')).toBe('+447311351565')
  })

  it('has no trunk zero for a North American site', () => {
    expect(tidyPhone('+1 212 555 0123', '+1')).toBe('2125550123')
  })

  it('refuses something too short to be a number', () => {
    expect(phoneKey('123', '+44')).toBeNull()
    expect(tidyPhone('', '+44')).toBeNull()
  })
})

describe('isOwnSender', () => {
  it('treats anything we sent as ours, whoever it went to', () => {
    expect(isOwnSender({ direction: 'out', fromAddress: 'hi@deskwell.co.uk' }, gate())).toBe(true)
  })

  it('treats an internal note as ours - it never left the building', () => {
    expect(isOwnSender({ direction: 'note', fromAddress: null }, gate())).toBe(true)
  })

  it('recognises post arriving back at one of our own inboxes', () => {
    const g = gate({ ownAddresses: new Set(['hi@deskwell.co.uk']) })
    expect(isOwnSender({ direction: 'in', fromAddress: 'Hi@Deskwell.co.uk' }, g)).toBe(true)
  })

  it('recognises a colleague writing from their own account address', () => {
    const g = gate({ staffAddresses: new Set(['chris@elsewhere.com']) })
    expect(isOwnSender({ direction: 'in', fromAddress: 'chris@elsewhere.com' }, g)).toBe(true)
  })

  it('recognises anybody at one of our own domains', () => {
    const g = gate({ ownDomains: ['deskwell.co.uk'] })
    expect(isOwnSender({ direction: 'in', fromAddress: 'marcus@deskwell.co.uk' }, g)).toBe(true)
  })

  it('does not recognise a stranger, which is the whole point', () => {
    const g = gate({ ownDomains: ['deskwell.co.uk'], ownAddresses: new Set(['hi@deskwell.co.uk']) })
    expect(isOwnSender({ direction: 'in', fromAddress: 'jane@customer.com' }, g)).toBe(false)
  })

  it('does not recognise a lookalike domain', () => {
    const g = gate({ ownDomains: ['deskwell.co.uk'] })
    expect(isOwnSender({ direction: 'in', fromAddress: 'jane@notdeskwell.co.uk' }, g)).toBe(false)
  })

  it('treats an inbound message with no sender at all as a stranger', () => {
    expect(isOwnSender({ direction: 'in', fromAddress: null }, gate())).toBe(false)
  })
})

describe('shouldBecomePerson', () => {
  it('accepts an ordinary customer', () => {
    expect(shouldBecomePerson('jane@customer.com', gate())).toBe(true)
  })

  it('refuses a blocked sender, however it is capitalised', () => {
    // Blocking takes them out of the address book; without this the next pass
    // would put them straight back.
    const g = gate({ blockedAddresses: new Set(['spam@example.com']) })
    expect(shouldBecomePerson('  Spam@Example.COM ', g)).toBe(false)
  })

  it('blocks only the address that was blocked, not its plus-tagged cousins', () => {
    const g = gate({ blockedAddresses: new Set(['ada+offers@example.com']) })
    expect(shouldBecomePerson('ada+offers@example.com', g)).toBe(false)
    expect(shouldBecomePerson('ada@example.com', g)).toBe(true)
  })

  it('refuses one of our own inboxes', () => {
    const g = gate({ ownAddresses: new Set(['hi@deskwell.co.uk']) })
    expect(shouldBecomePerson('hi@deskwell.co.uk', g)).toBe(false)
  })

  it('refuses a plus-addressed form of one of our own inboxes', () => {
    const g = gate({ ownAddresses: new Set(['hi@deskwell.co.uk']) })
    expect(shouldBecomePerson('hi+orders@deskwell.co.uk', g)).toBe(false)
  })

  it('refuses a member of staff', () => {
    const g = gate({ staffAddresses: new Set(['chris@elsewhere.com']) })
    expect(shouldBecomePerson('Chris@Elsewhere.com', g)).toBe(false)
  })

  it('refuses anybody at one of our own domains - E18', () => {
    const g = gate({ ownDomains: ['deskwell.co.uk'] })
    expect(shouldBecomePerson('marcus@deskwell.co.uk', g)).toBe(false)
    expect(shouldBecomePerson('marcus@somewhereelse.co.uk', g)).toBe(true)
  })

  it('refuses the mail system talking to itself', () => {
    expect(shouldBecomePerson('MAILER-DAEMON@example.com', gate())).toBe(false)
    expect(shouldBecomePerson('no-reply@example.com', gate())).toBe(false)
  })

  it('accepts a role address, which is several humans by design - E19', () => {
    expect(shouldBecomePerson('accounts@supplier.com', gate())).toBe(true)
  })
})

describe('resolveOwnDomains', () => {
  it('works them out from the inbox addresses when nothing is configured', () => {
    expect(resolveOwnDomains(['hi@deskwell.co.uk', 'marcus@deskwell.co.uk'], null))
      .toEqual(['deskwell.co.uk'])
  })

  it('never infers a free provider, whatever the inboxes are on', () => {
    // Otherwise a site whose only inbox is a Gmail address stops recognising
    // every Gmail correspondent it has, which is most of the customer list.
    expect(resolveOwnDomains(['shop@gmail.com'], null)).toEqual([])
  })

  it('believes an explicit list, including an empty one', () => {
    expect(resolveOwnDomains(['hi@deskwell.co.uk'], [])).toEqual([])
    expect(resolveOwnDomains(['hi@deskwell.co.uk'], ['Other.COM'])).toEqual(['other.com'])
  })
})

describe('organisationNameFromDomain', () => {
  it('reads a name off a co.uk domain rather than calling everybody Co', () => {
    expect(organisationNameFromDomain('deskwell.co.uk')).toBe('Deskwell')
  })

  it('handles an ordinary two-part domain', () => {
    expect(organisationNameFromDomain('acme.com')).toBe('Acme')
  })

  it('tidies a hyphenated name', () => {
    expect(organisationNameFromDomain('smith-and-sons.co.uk')).toBe('Smith And Sons')
  })

  it('never turns a free provider into a company', () => {
    for (const domain of ['gmail.com', 'icloud.com', 'btinternet.com']) {
      expect(organisationNameFromDomain(domain)).toBeNull()
    }
  })

  it('honours an extra provider the site has added', () => {
    expect(organisationNameFromDomain('regional.example', ['regional.example'])).toBeNull()
  })
})

describe('displayNameFor', () => {
  it('prefers what the sender put in their own header', () => {
    expect(displayNameFor('Jane Smith', 'j.smith@example.com')).toBe('Jane Smith')
  })

  it('ignores a display name that is only the address again', () => {
    expect(displayNameFor('jane@example.com', 'jane@example.com')).toBe('Jane')
  })

  it('makes something readable out of the local part', () => {
    expect(displayNameFor(null, 'jane.smith@example.com')).toBe('Jane Smith')
    expect(displayNameFor(null, 'jane_smith@example.com')).toBe('Jane Smith')
  })

  it('does not invent a person out of a random mailbox name', () => {
    expect(displayNameFor(null, 'ab12cd@example.com')).toBeNull()
  })
})

describe('domainOf and isPersonalDomain', () => {
  it('reads the domain half', () => {
    expect(domainOf('jane@Example.com')).toBe('example.com')
    expect(domainOf('nonsense')).toBeNull()
  })

  it('knows the usual free providers', () => {
    expect(CONSUMER_DOMAINS.length).toBeGreaterThan(20)
    expect(isPersonalDomain('gmail.com')).toBe(true)
    expect(isPersonalDomain('deskwell.co.uk')).toBe(false)
  })
})

describe('preferContactName', () => {
  it('shows the card name on a call whose name slot is only the number', () => {
    expect(preferContactName('07445164570', 'Chris Taylor-Guest')).toBe('Chris Taylor-Guest')
  })

  it('shows the card name on an email with no display name, or only an address', () => {
    expect(preferContactName(null, 'Ada Lovelace')).toBe('Ada Lovelace')
    expect(preferContactName('ada@example.com', 'Ada Lovelace')).toBe('Ada Lovelace')
  })

  it('keeps a real name on the message', () => {
    expect(preferContactName('Ben Burrows', 'B. Burrows Ltd')).toBe('Ben Burrows')
  })

  it('falls back to the message when the card is itself only a number', () => {
    expect(preferContactName('07700900123', '07700900123')).toBe('07700900123')
    expect(preferContactName(null, '+447700900123')).toBeNull()
  })
})
