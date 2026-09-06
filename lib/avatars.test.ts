import { describe, expect, it } from 'vitest'
import {
  domainOf, emailHash, federatedUrl, isPublicAddress, normaliseEmail, pickSrv,
} from './avatars'

describe('normaliseEmail', () => {
  it('trims and folds case, which is what both services hash', () => {
    expect(normaliseEmail('  Pierre@Example.COM ')).toBe('pierre@example.com')
  })
})

describe('emailHash', () => {
  // The published SHA-256 of the empty string, so the hash is checked against
  // something outside this file rather than against itself.
  it('is the SHA-256 of the normalised address', () => {
    expect(emailHash('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('gives one answer for the same address written two ways', () => {
    expect(emailHash('Pierre@Example.com ')).toBe(emailHash('pierre@example.com'))
  })
})

describe('domainOf', () => {
  it('takes the part after the last @', () => {
    expect(domainOf('pierre@auditlawyer.club')).toBe('auditlawyer.club')
  })

  it('refuses anything that is not one plain domain', () => {
    // No @ at all, nothing before it, no dot, an address literal, and a name
    // with something in it that has no business in a DNS query.
    expect(domainOf('pierre')).toBeNull()
    expect(domainOf('@example.com')).toBeNull()
    expect(domainOf('root@localhost')).toBeNull()
    expect(domainOf('a@[192.168.0.1]')).toBeNull()
    expect(domainOf('a@exa mple.com')).toBeNull()
  })
})

describe('isPublicAddress', () => {
  it('accepts ordinary addresses out on the internet', () => {
    expect(isPublicAddress('93.184.216.34')).toBe(true)
    expect(isPublicAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(true)
  })

  // Every one of these is somewhere a stranger could point their own SRV record
  // to get this server to fetch from the inside of its own network. The last is
  // the cloud metadata endpoint, which is where the credentials are.
  it('refuses everything that is not', () => {
    for (const ip of [
      '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '172.31.255.255',
      '0.0.0.0', '100.64.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
      '169.254.169.254',
      '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1',
      'not-an-ip', '',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false)
    }
  })

  it('reads an IPv4 address in an IPv6 coat by the IPv4 rules', () => {
    expect(isPublicAddress('::ffff:93.184.216.34')).toBe(true)
    expect(isPublicAddress('::ffff:10.0.0.1')).toBe(false)
  })
})

describe('pickSrv', () => {
  const record = (name: string, priority: number, weight: number, port = 443) =>
    ({ name, port, priority, weight })

  it('takes the lowest priority', () => {
    expect(pickSrv([record('b.example', 20, 100), record('a.example', 10, 1)])?.name)
      .toBe('a.example')
  })

  it('breaks a tie on priority by weight, so the answer can be cached', () => {
    expect(pickSrv([record('light.example', 10, 1), record('heavy.example', 10, 90)])?.name)
      .toBe('heavy.example')
  })

  it('steps over a record with no name or an impossible port', () => {
    expect(pickSrv([record('', 1, 1), record('bad.example', 1, 1, 70000), record('ok.example', 9, 1)])?.name)
      .toBe('ok.example')
  })

  it('is null when there is nothing usable', () => {
    expect(pickSrv([])).toBeNull()
    expect(pickSrv([record('', 1, 1)])).toBeNull()
  })
})

describe('federatedUrl', () => {
  it('leaves the port off when it is the ordinary one', () => {
    expect(federatedUrl('avatars.example', 443, 'abc', 64))
      .toBe('https://avatars.example/avatar/abc?s=64&d=404')
  })

  it('spells it out when it is not', () => {
    expect(federatedUrl('avatars.example', 8443, 'abc', 64))
      .toBe('https://avatars.example:8443/avatar/abc?s=64&d=404')
  })

  // Without d=404 the service answers every hash with a generated pattern, the
  // first source always "succeeds", and nothing further down the chain is ever
  // reached.
  it('always asks for a 404 rather than a generated picture', () => {
    expect(federatedUrl('avatars.example', 443, 'abc', 64)).toContain('d=404')
  })
})
