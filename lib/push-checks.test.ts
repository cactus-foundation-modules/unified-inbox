import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  PUSH_SAFETY_CHECK_MS,
  dueOnSchedule,
  hookSignatureMatches,
  looksLikePushToken,
  mintPushToken,
  pushUrl,
  rangAgain,
  ringAnswered,
} from './push-checks'

const NOW = Date.parse('2026-09-27T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms)

describe('dueOnSchedule', () => {
  it('opens every ordinary account, however recently it was checked', () => {
    expect(dueOnSchedule({ pushChecks: false, lastSyncAt: ago(1_000) }, NOW)).toBe(true)
  })

  it('leaves a push account alone while it has been checked inside the safety window', () => {
    expect(dueOnSchedule({ pushChecks: true, lastSyncAt: ago(PUSH_SAFETY_CHECK_MS - 1) }, NOW)).toBe(false)
  })

  it('opens a push account once the safety window has passed, in case the provider stopped ringing', () => {
    expect(dueOnSchedule({ pushChecks: true, lastSyncAt: ago(PUSH_SAFETY_CHECK_MS) }, NOW)).toBe(true)
  })

  it('opens a push account that has never been checked at all', () => {
    expect(dueOnSchedule({ pushChecks: true, lastSyncAt: null }, NOW)).toBe(true)
  })
})

describe('hookSignatureMatches', () => {
  const secret = 'zoho-first-request-secret'
  const body = Buffer.from('{"subject":"Order 1234","fromAddress":"a@example.com"}')
  const sign = (b: Buffer, key = secret) => createHmac('sha256', key).update(b).digest('base64')

  it('accepts the base64 HMAC-SHA256 of the raw body under the stored secret', () => {
    expect(hookSignatureMatches(secret, body, sign(body))).toBe(true)
  })

  it('accepts an empty body signed the same way - a ring with nothing in it', () => {
    const empty = Buffer.alloc(0)
    expect(hookSignatureMatches(secret, empty, sign(empty))).toBe(true)
  })

  it('refuses a signature made with another key', () => {
    expect(hookSignatureMatches(secret, body, sign(body, 'somebody-else'))).toBe(false)
  })

  it('refuses a body changed after signing', () => {
    expect(hookSignatureMatches(secret, Buffer.from(`${body} `), sign(body))).toBe(false)
  })

  it('refuses a missing or truncated signature without throwing', () => {
    expect(hookSignatureMatches(secret, body, null)).toBe(false)
    expect(hookSignatureMatches(secret, body, sign(body).slice(0, 10))).toBe(false)
  })
})

describe('tokens and the address', () => {
  it('mints tokens the route will recognise', () => {
    const token = mintPushToken()
    expect(looksLikePushToken(token)).toBe(true)
    expect(mintPushToken()).not.toBe(token)
  })

  it('refuses anything not shaped like one before the database is asked', () => {
    expect(looksLikePushToken('')).toBe(false)
    expect(looksLikePushToken("' OR 1=1 --")).toBe(false)
    expect(looksLikePushToken('A'.repeat(48))).toBe(false)
  })

  it('builds the address under the module route, without a doubled slash', () => {
    expect(pushUrl('https://example.co.uk/', 'abc')).toBe(
      'https://example.co.uk/api/m/unified-inbox/webhooks/new-mail?token=abc',
    )
  })
})

describe('ringAnswered and rangAgain', () => {
  const t = (s: number) => new Date(NOW + s * 1000)

  it('counts a ring as covered only by a check that noted it or a later one', () => {
    expect(ringAnswered(t(5), t(5))).toBe(true)
    expect(ringAnswered(t(5), t(9))).toBe(true)
    expect(ringAnswered(t(5), t(4))).toBe(false)
    expect(ringAnswered(t(5), null)).toBe(false)
  })

  it('sends a check back round only for a ring newer than the one it started with', () => {
    expect(rangAgain(t(5), t(5))).toBe(false)
    expect(rangAgain(t(5), t(6))).toBe(true)
    expect(rangAgain(null, t(6))).toBe(true)
    expect(rangAgain(t(5), null)).toBe(false)
  })
})
