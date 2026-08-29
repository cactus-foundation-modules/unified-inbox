import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { isPrivateAddress, signBody, bodyFor } from './webhooks'
import { headerProblem, literalProblem } from './webhook-validation'
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
