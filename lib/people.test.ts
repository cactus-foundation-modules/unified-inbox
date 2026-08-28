import { describe, it, expect } from 'vitest'
import {
  CONSUMER_DOMAINS,
  displayNameFor,
  domainOf,
  identityKey,
  isPersonalDomain,
  organisationNameFromDomain,
  phoneKey,
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

describe('phoneKey', () => {
  it('reduces a number written several ways to one identity', () => {
    expect(phoneKey('01234 567 890')).toBe('01234567890')
    expect(phoneKey('(01234) 567890')).toBe('01234567890')
  })

  it('keeps a leading plus, which is the country code', () => {
    expect(phoneKey('+44 1234 567890')).toBe('+441234567890')
  })

  it('refuses something too short to be a number', () => {
    expect(phoneKey('123')).toBeNull()
  })
})

describe('shouldBecomePerson', () => {
  it('accepts an ordinary customer', () => {
    expect(shouldBecomePerson('jane@customer.com', gate())).toBe(true)
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
