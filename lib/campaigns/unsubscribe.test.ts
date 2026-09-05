import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  tokenMatches,
  unsubscribeFooter,
  unsubscribeHeaders,
  unsubscribeToken,
  unsubscribeUrl,
} from './unsubscribe'

// The unsubscribe link. The one part of this feature with a legal deadline on
// it, and the one that has to keep working years after the campaign that
// carried it has been deleted.

const KEY = 'a'.repeat(64)
const OTHER_KEY = 'b'.repeat(64)
let original: string | undefined

beforeAll(() => {
  original = process.env.ENCRYPTION_KEY
  process.env.ENCRYPTION_KEY = KEY
})

afterAll(() => {
  if (original === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = original
})

describe('the token', () => {
  it('is the same every time for the same address', () => {
    // So a second campaign carries the same link, and a link somebody
    // bookmarked in January still works in June.
    expect(unsubscribeToken('jane@acme.co.uk')).toBe(unsubscribeToken('jane@acme.co.uk'))
  })

  it('does not care how the address was typed', () => {
    expect(unsubscribeToken(' Jane@Acme.co.uk ')).toBe(unsubscribeToken('jane@acme.co.uk'))
  })

  it('is different for a different address', () => {
    expect(unsubscribeToken('jane@acme.co.uk')).not.toBe(unsubscribeToken('john@acme.co.uk'))
  })

  it('matches its own address and nobody else', () => {
    const token = unsubscribeToken('jane@acme.co.uk')
    expect(tokenMatches('jane@acme.co.uk', token)).toBe(true)
    // The whole point: nobody can unsubscribe anybody else by editing the
    // address bar.
    expect(tokenMatches('john@acme.co.uk', token)).toBe(false)
    expect(tokenMatches('jane@acme.co.uk', 'not-a-real-token')).toBe(false)
    expect(tokenMatches('jane@acme.co.uk', '')).toBe(false)
  })

  it('is keyed to this site, so a link made on another site does not work here', () => {
    const here = unsubscribeToken('jane@acme.co.uk')
    process.env.ENCRYPTION_KEY = OTHER_KEY
    const there = unsubscribeToken('jane@acme.co.uk')
    process.env.ENCRYPTION_KEY = KEY
    expect(here).not.toBe(there)
    expect(tokenMatches('jane@acme.co.uk', there)).toBe(false)
  })

  it('refuses rather than throwing when the site has no key', () => {
    delete process.env.ENCRYPTION_KEY
    expect(tokenMatches('jane@acme.co.uk', 'anything')).toBe(false)
    process.env.ENCRYPTION_KEY = KEY
  })
})

describe('the link', () => {
  it('carries the address in the clear, so the page can say what it is about', () => {
    const url = new URL(unsubscribeUrl('https://deskwell.co.uk', 'Jane@Acme.co.uk', 'camp-1'))
    expect(url.pathname).toBe('/api/m/unified-inbox/unsubscribe')
    expect(url.searchParams.get('e')).toBe('jane@acme.co.uk')
    expect(url.searchParams.get('t')).toBe(unsubscribeToken('jane@acme.co.uk'))
    expect(url.searchParams.get('c')).toBe('camp-1')
  })

  it('works without a campaign, because the link outlives the campaign', () => {
    const url = new URL(unsubscribeUrl('https://deskwell.co.uk/', 'jane@acme.co.uk'))
    expect(url.searchParams.get('c')).toBeNull()
  })
})

describe('the headers', () => {
  it('offers a mail program its own unsubscribe button', () => {
    const headers = unsubscribeHeaders('https://deskwell.co.uk/unsub')
    expect(headers['List-Unsubscribe']).toBe('<https://deskwell.co.uk/unsub>')
    // Without this second one Gmail will not show the button at all.
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
  })
})

describe('the footer', () => {
  it('says who it is from and how to stop it', () => {
    const footer = unsubscribeFooter('https://deskwell.co.uk/unsub', {
      siteName: 'Deskwell',
      postalAddress: '1 High Street\nLeeds\nLS1 1AA',
    })
    expect(footer.html).toContain('Deskwell, 1 High Street, Leeds, LS1 1AA')
    expect(footer.html).toContain('https://deskwell.co.uk/unsub')
    expect(footer.text).toContain('Unsubscribe: https://deskwell.co.uk/unsub')
    expect(footer.text).toContain('Deskwell, 1 High Street, Leeds, LS1 1AA')
  })

  it('manages with a name alone', () => {
    const footer = unsubscribeFooter('https://deskwell.co.uk/unsub', {
      siteName: 'Deskwell', postalAddress: null,
    })
    expect(footer.html).toContain('Deskwell')
    expect(footer.text).toContain('Deskwell')
  })

  it('escapes a business name with an ampersand in it', () => {
    const footer = unsubscribeFooter('https://x/u', { siteName: 'Smith & Sons', postalAddress: null })
    expect(footer.html).toContain('Smith &amp; Sons')
    expect(footer.html).not.toContain('Smith & Sons')
  })
})
