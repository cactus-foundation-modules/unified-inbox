import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { isPrivateAddress, signBody, bodyFor } from './webhooks'
import { headerProblem, literalProblem } from './webhook-validation'
import { chooseCredentials } from './webhooks-db'
import type { Webhook } from './webhook-types'

// The three things here that are worth a test are the three that fail quietly:
// an address check that lets an internal one through, a signature the far end
// cannot reproduce, and a literal body that goes out as an empty object.

function hook(over: Partial<Webhook> = {}): Webhook {
  return {
    id: 'w1',
    name: 'Test',
    inboxId: null,
    url: 'https://example.com/hook',
    enabled: true,
    events: ['message.received'],
    payloadStyle: 'event',
    literalBody: null,
    includeBody: false,
    hasSecret: false,
    hasHeaders: false,
    secretSource: 'none',
    headersSource: 'none',
    lastStatus: null,
    lastAttemptAt: null,
    lastError: null,
    consecutiveFailures: 0,
    autoDisabledAt: null,
    createdAt: new Date(),
    ...over,
  }
}

describe('isPrivateAddress', () => {
  it('refuses the addresses a webhook must never reach', () => {
    for (const address of [
      '127.0.0.1', '127.1.2.3',        // this server
      '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.10',  // private networks
      '169.254.169.254',               // the cloud metadata service, which hands out credentials
      '100.64.0.1',                    // carrier-grade NAT
      '0.0.0.0', '224.0.0.1',
      '::1', 'fc00::1', 'fe80::1',
      '::ffff:127.0.0.1',              // an internal address wearing an IPv6 hat
    ]) {
      expect(isPrivateAddress(address), address).toBe(true)
    }
  })

  it('allows ordinary public addresses', () => {
    for (const address of ['93.184.216.34', '1.1.1.1', '172.32.0.1', '192.169.0.1', '2606:4700::1111']) {
      expect(isPrivateAddress(address), address).toBe(false)
    }
  })

  it('treats anything it cannot parse as not allowed', () => {
    expect(isPrivateAddress('nonsense')).toBe(true)
    expect(isPrivateAddress('1.2.3')).toBe(true)
    expect(isPrivateAddress('1.2.3.999')).toBe(true)
  })
})

describe('signBody', () => {
  it('produces a signature the far end can reproduce from what it is sent', () => {
    const body = JSON.stringify({ hello: 'world' })
    const signed = signBody('shhh', '/run', body)

    const expected = crypto
      .createHmac('sha256', 'shhh')
      .update(`${signed.timestamp}.${signed.nonce}.POST./run.${body}`)
      .digest('hex')

    expect(signed.signature).toBe(expected)
  })

  it('signs two identical bodies differently', () => {
    // Without this a receiver that refuses a repeated signature - which is the
    // point of keeping one - would throw away the second of two identical
    // notifications sent in the same second.
    const a = signBody('shhh', '/run', '{}')
    const b = signBody('shhh', '/run', '{}')
    expect(a.signature).not.toBe(b.signature)
  })
})

describe('bodyFor', () => {
  it('sends the fixed body verbatim for a literal subscription', () => {
    const body = bodyFor(hook({ payloadStyle: 'literal', literalBody: '{"skill":"marcus"}' }), null)
    expect(body).toBe('{"skill":"marcus"}')
  })

  it('sends the queued payload for an event subscription', () => {
    const body = bodyFor(hook(), { style: 'event', body: { event: 'message.received' } })
    expect(JSON.parse(body)).toEqual({ event: 'message.received' })
  })
})

describe('validation helpers', () => {
  it('refuses headers that would break the request or the signature', () => {
    expect(headerProblem({ Host: 'elsewhere.example' })).toBeTruthy()
    expect(headerProblem({ 'x-cactus-signature': 'nope' })).toBeTruthy()
    expect(headerProblem({ 'CF-Access-Client-Id': 'abc.access' })).toBeNull()
    expect(headerProblem(null)).toBeNull()
  })

  it('refuses a literal subscription with nothing sendable in it', () => {
    expect(literalProblem('literal', '')).toBeTruthy()
    expect(literalProblem('literal', 'not json')).toBeTruthy()
    expect(literalProblem('literal', '{"skill":"marcus"}')).toBeNull()
    expect(literalProblem('event', null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Which password and which headers a delivery actually goes out with.
//
// Worth a test of its own because both mistakes are silent. Reaching for the
// shared password where the subscription has its own gets a rejection at the
// far end that reads like a network fault; reaching for it where the answer was
// meant to be "none" hands a password to an endpoint nobody gave it to.
// ---------------------------------------------------------------------------

describe('chooseCredentials', () => {
  const own = { secret: 'its-own', headers: { 'X-Own': 'yes' } }
  const shared = { secret: 'the-shared-one', headers: { 'X-Shared': 'yes' } }

  it('takes the subscription’s own when it says own', () => {
    const got = chooseCredentials({ secretSource: 'own', headersSource: 'own' }, own, shared)
    expect(got).toEqual(own)
  })

  it('takes the site’s shared pair when it says shared', () => {
    const got = chooseCredentials({ secretSource: 'shared', headersSource: 'shared' }, own, shared)
    expect(got).toEqual(shared)
  })

  it('takes neither when it says none, even with both to hand', () => {
    const got = chooseCredentials({ secretSource: 'none', headersSource: 'none' }, own, shared)
    expect(got).toEqual({ secret: null, headers: {} })
  })

  it('settles the two halves separately', () => {
    const got = chooseCredentials({ secretSource: 'shared', headersSource: 'own' }, own, shared)
    expect(got.secret).toBe('the-shared-one')
    expect(got.headers).toEqual({ 'X-Own': 'yes' })
  })

  it('signs with nothing when the shared password is not set', () => {
    const got = chooseCredentials(
      { secretSource: 'shared', headersSource: 'none' },
      own,
      { secret: null, headers: {} },
    )
    expect(got.secret).toBeNull()
  })
})
