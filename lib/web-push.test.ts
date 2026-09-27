import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  b64url,
  encryptPayload,
  fromB64url,
  generateVapidKeys,
  isAllowedPushEndpoint,
  isVapidKeys,
  sendWebPush,
  vapidAuthorization,
} from './web-push'

// RFC 8291 Appendix A, copied from the RFC with its line-wrapping removed. The
// whole point of this block is that nobody - least of all whoever wrote the
// encryption - made these numbers up.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
}

/** The browser's half, written out independently of the sealing code: what a
 *  real browser does to open the message. */
function openAsBrowser(body: Buffer, uaPrivate: string, auth: string): string {
  const salt = body.subarray(0, 16)
  const idLength = body.readUInt8(20)
  const asPublic = body.subarray(21, 21 + idLength)
  const sealed = body.subarray(21 + idLength)
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(fromB64url(uaPrivate))
  const shared = ecdh.computeSecret(asPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', shared, fromB64url(auth), keyInfo, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(sealed.subarray(sealed.length - 16))
  const record = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()])
  expect(record.at(-1)).toBe(0x02)
  return record.subarray(0, record.length - 1).toString('utf8')
}

describe('encryptPayload', () => {
  it("matches RFC 8291's worked example byte for byte", () => {
    const body = encryptPayload(
      Buffer.from(RFC.plaintext),
      { p256dh: RFC.uaPublic, auth: RFC.auth },
      { salt: fromB64url(RFC.salt), senderPrivateKey: fromB64url(RFC.asPrivate) },
    )
    expect(b64url(body.subarray(0, 86))).toBe(RFC.header)
    expect(b64url(body.subarray(86))).toBe(RFC.ciphertext)
  })

  it('opens for the browser it was sealed to, with a fresh salt and key every time', () => {
    const one = encryptPayload(Buffer.from('{"title":"Ada"}'), { p256dh: RFC.uaPublic, auth: RFC.auth })
    const two = encryptPayload(Buffer.from('{"title":"Ada"}'), { p256dh: RFC.uaPublic, auth: RFC.auth })
    expect(one.equals(two)).toBe(false)
    expect(openAsBrowser(one, RFC.uaPrivate, RFC.auth)).toBe('{"title":"Ada"}')
    expect(openAsBrowser(two, RFC.uaPrivate, RFC.auth)).toBe('{"title":"Ada"}')
  })

  it('refuses keys that are not the shape a browser hands over', () => {
    expect(() => encryptPayload(Buffer.from('x'), { p256dh: RFC.salt, auth: RFC.auth })).toThrow()
    expect(() => encryptPayload(Buffer.from('x'), { p256dh: RFC.uaPublic, auth: RFC.salt + 'AA' })).toThrow()
  })

  it('refuses a payload that would not fit one record', () => {
    expect(() => encryptPayload(Buffer.alloc(4096), { p256dh: RFC.uaPublic, auth: RFC.auth })).toThrow()
  })
})

describe('VAPID', () => {
  it('makes a usable pair', () => {
    const keys = generateVapidKeys()
    expect(fromB64url(keys.publicKey)).toHaveLength(65)
    expect(fromB64url(keys.privateKey)).toHaveLength(32)
    expect(isVapidKeys(keys)).toBe(true)
  })

  it('tells a pair that does not belong together from one that does', () => {
    const a = generateVapidKeys()
    const b = generateVapidKeys()
    expect(isVapidKeys({ publicKey: a.publicKey, privateKey: b.privateKey })).toBe(false)
    expect(isVapidKeys({ publicKey: 'nonsense', privateKey: a.privateKey })).toBe(false)
    expect(isVapidKeys({ publicKey: RFC.asPublic, privateKey: RFC.asPrivate })).toBe(true)
  })

  it('signs a token the public key verifies, addressed to the push service and nobody else', () => {
    const keys = generateVapidKeys()
    const now = Date.UTC(2026, 8, 27, 12, 0, 0)
    const header = vapidAuthorization('https://web.push.apple.com/QGuQyavXu', keys, 'https://deskwell.example', now)
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)
    expect(match).not.toBeNull()
    const [, head, body, signature, k] = match!
    expect(k).toBe(keys.publicKey)
    expect(JSON.parse(fromB64url(head!).toString())).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(JSON.parse(fromB64url(body!).toString())).toEqual({
      aud: 'https://web.push.apple.com',
      exp: now / 1000 + 12 * 60 * 60,
      sub: 'https://deskwell.example',
    })
    const point = fromB64url(keys.publicKey)
    const publicKey = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33)) },
      format: 'jwk',
    })
    const raw = fromB64url(signature!)
    expect(raw).toHaveLength(64)
    expect(verify('sha256', Buffer.from(`${head}.${body}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw)).toBe(true)
  })
})

describe('isAllowedPushEndpoint', () => {
  it('takes the push services the browsers people use are wired to', () => {
    expect(isAllowedPushEndpoint('https://web.push.apple.com/QGuQyavXutnMH')).toBe(true)
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc:def')).toBe(true)
    expect(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/gAAA')).toBe(true)
    expect(isAllowedPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=BQYAAA')).toBe(true)
  })

  it('refuses everything else, however it is dressed up', () => {
    expect(isAllowedPushEndpoint('http://fcm.googleapis.com/fcm/send/abc')).toBe(false)
    expect(isAllowedPushEndpoint('https://evilpush.apple.com.example.org/x')).toBe(false)
    expect(isAllowedPushEndpoint('https://notpush.apple.com/x')).toBe(false)
    expect(isAllowedPushEndpoint('https://169.254.169.254/latest/meta-data')).toBe(false)
    expect(isAllowedPushEndpoint('https://user:pw@fcm.googleapis.com/x')).toBe(false)
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com:8443/x')).toBe(false)
    expect(isAllowedPushEndpoint('not a url')).toBe(false)
  })
})

describe('sendWebPush', () => {
  const keys = generateVapidKeys()
  const subscription = { endpoint: 'https://web.push.apple.com/abc', p256dh: RFC.uaPublic, auth: RFC.auth }

  it('posts a sealed body with the headers every push service asks for', async () => {
    let seen: { url: string; init: RequestInit } | null = null
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return new Response(null, { status: 201 })
    }) as unknown as typeof fetch
    const outcome = await sendWebPush(subscription, '{"title":"Ada"}', { keys, subject: 'https://site.example' },
      { ttlSeconds: 3600, urgency: 'high', timeoutMs: 1000 }, fake)
    expect(outcome).toEqual({ ok: true, status: 201, gone: false })
    const { url, init } = seen!
    expect(url).toBe(subscription.endpoint)
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Encoding']).toBe('aes128gcm')
    expect(headers.TTL).toBe('3600')
    expect(headers.Urgency).toBe('high')
    expect(headers.Authorization).toMatch(/^vapid t=.+, k=/)
    expect(openAsBrowser(Buffer.from(init.body as Uint8Array), RFC.uaPrivate, RFC.auth)).toBe('{"title":"Ada"}')
  })

  it('says a browser is gone when the push service says so', async () => {
    for (const status of [404, 410]) {
      const fake = (async () => new Response(null, { status })) as unknown as typeof fetch
      const outcome = await sendWebPush(subscription, '{}', { keys, subject: 'https://site.example' },
        { ttlSeconds: 60, urgency: 'high', timeoutMs: 1000 }, fake)
      expect(outcome).toEqual({ ok: false, status, gone: true })
    }
  })

  it('never posts to an address that is not a push service', async () => {
    let called = false
    const fake = (async () => { called = true; return new Response(null, { status: 201 }) }) as unknown as typeof fetch
    const outcome = await sendWebPush({ ...subscription, endpoint: 'https://internal.example/hook' }, '{}',
      { keys, subject: 'https://site.example' }, { ttlSeconds: 60, urgency: 'high', timeoutMs: 1000 }, fake)
    expect(called).toBe(false)
    expect(outcome.gone).toBe(true)
  })
})
