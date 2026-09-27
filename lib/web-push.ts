import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
} from 'node:crypto'

// ---------------------------------------------------------------------------
// Web Push, from the sending end: the three standards every browser's push
// service speaks, written against node:crypto rather than pulled in as a
// package, because a module ships no dependencies of its own.
//
//   RFC 8292 (VAPID)  - the site signs a short token saying who it is, so a
//                       push service will only accept messages for a browser
//                       from the site that browser subscribed to.
//   RFC 8291 + 8188   - the payload is sealed to the browser's own key before
//                       it leaves, so Apple, Google or Mozilla carry a subject
//                       line they cannot read.
//   RFC 8030          - the POST itself, with its TTL and urgency.
//
// Pure apart from `sendWebPush`, which takes its fetch as an argument, so all
// of it is tested against the RFC's own worked example.
// ---------------------------------------------------------------------------

export type VapidKeys = {
  /** Uncompressed P-256 point, base64url - 65 bytes. What a browser is handed
   *  as `applicationServerKey`. */
  publicKey: string
  /** The private scalar, base64url - 32 bytes. Never leaves the server. */
  privateKey: string
}

export type PushSubscriptionKeys = {
  endpoint: string
  /** The browser's public key, base64url. */
  p256dh: string
  /** The browser's 16-byte authentication secret, base64url. */
  auth: string
}

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

export function fromB64url(value: string): Buffer {
  return Buffer.from(value, 'base64url')
}

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = privateKey.export({ format: 'jwk' })
  if (!jwk.x || !jwk.y || !jwk.d) throw new Error('P-256 key export came back without its coordinates')
  const point = Buffer.concat([Buffer.from([0x04]), fromB64url(jwk.x), fromB64url(jwk.y)])
  return { publicKey: b64url(point), privateKey: jwk.d }
}

/** Whether a stored pair is a usable P-256 pair, before anything is signed with
 *  it. A key that decrypted to rubbish (a restore onto a site with a different
 *  ENCRYPTION_KEY) should read as "no key", not throw halfway through a send. */
export function isVapidKeys(keys: VapidKeys): boolean {
  try {
    const point = fromB64url(keys.publicKey)
    const d = fromB64url(keys.privateKey)
    if (point.length !== 65 || point[0] !== 0x04 || d.length !== 32) return false
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(d)
    return ecdh.getPublicKey().equals(point)
  } catch {
    return false
  }
}

function signingKey(keys: VapidKeys) {
  const point = fromB64url(keys.publicKey)
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64url(point.subarray(1, 33)),
      y: b64url(point.subarray(33, 65)),
      d: keys.privateKey,
    },
    format: 'jwk',
  })
}

/** How long a signed token is good for. The ceiling is 24 hours; twelve is what
 *  everybody uses, and a token is made fresh for every send anyway. */
const VAPID_LIFETIME_S = 12 * 60 * 60

/**
 * The Authorization header for one push service.
 *
 * `subject` is a contact for the push service's operators - a mailto: or an
 * https: address. Apple refuses a send without one, so it is required here.
 */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  nowMs: number = Date.now(),
): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64url(Buffer.from(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(nowMs / 1000) + VAPID_LIFETIME_S,
    sub: subject,
  })))
  const unsigned = `${header}.${claims}`
  // ES256 in a JWT is the raw r||s pair, not the DER a signature comes out of
  // node in by default - the one detail every hand-written VAPID gets wrong.
  const signature = sign('sha256', Buffer.from(unsigned), { key: signingKey(keys), dsaEncoding: 'ieee-p1363' })
  return `vapid t=${unsigned}.${b64url(signature)}, k=${keys.publicKey}`
}

/** One record of this size holds any payload this module sends; the push
 *  services cap a body at 4096 bytes in any case. */
const RECORD_SIZE = 4096

/**
 * Seals a payload to one browser (RFC 8291, aes128gcm).
 *
 * `fixed` exists for the tests alone: the RFC's worked example pins the salt
 * and the sender's ephemeral key so its output can be checked byte for byte.
 * Everything real leaves it out and gets a fresh salt and key per message.
 */
export function encryptPayload(
  plaintext: Uint8Array,
  subscription: Pick<PushSubscriptionKeys, 'p256dh' | 'auth'>,
  fixed?: { salt: Uint8Array; senderPrivateKey: Uint8Array },
): Buffer {
  const uaPublic = fromB64url(subscription.p256dh)
  const authSecret = fromB64url(subscription.auth)
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('p256dh is not an uncompressed P-256 point')
  if (authSecret.length !== 16) throw new Error('auth secret is not 16 bytes')

  const ecdh = createECDH('prime256v1')
  if (fixed) ecdh.setPrivateKey(Buffer.from(fixed.senderPrivateKey))
  else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const shared = ecdh.computeSecret(uaPublic)
  const salt = fixed ? Buffer.from(fixed.salt) : randomBytes(16)

  // RFC 8291 section 3.4: the browser's secret and both public keys go into
  // the keying material, so a message sealed to one subscription opens for no
  // other.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32))
  // RFC 8188 section 2.2 and 2.3.
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))

  // One record, so it is also the last: the delimiter is 2 and no padding
  // follows it.
  const record = Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])])
  if (record.length + 16 > RECORD_SIZE) throw new Error('payload is too large for one push record')
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const sealed = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()])

  const header = Buffer.alloc(16 + 4 + 1)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header.writeUInt8(asPublic.length, 20)
  return Buffer.concat([header, asPublic, sealed])
}

/**
 * The push services this site will post to, by host.
 *
 * A subscription's endpoint is an address a browser handed over, and the server
 * then POSTs to it - so an open list would let anybody signed in point the site
 * at whatever they liked, internal addresses included. These are the services
 * the browsers people actually use are wired to: Apple's for Safari on every
 * device, Google's for Chrome and Edge on Android and most of the Chromium
 * family, Mozilla's for Firefox and Microsoft's for Edge on Windows.
 */
const PUSH_SERVICE_HOSTS = [
  'push.apple.com',
  'fcm.googleapis.com',
  'push.services.mozilla.com',
  'notify.windows.com',
] as const

export function isAllowedPushEndpoint(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
  const host = url.hostname.toLowerCase()
  return PUSH_SERVICE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
}

export type PushOutcome = {
  ok: boolean
  status: number
  /** The push service says this browser is gone for good - unsubscribed,
   *  uninstalled, or its subscription expired. The row should go. */
  gone: boolean
}

export type PushOptions = {
  /** How long the push service should hold the message for a browser that is
   *  offline, in seconds. */
  ttlSeconds: number
  urgency: 'very-low' | 'low' | 'normal' | 'high'
  /** How long to wait for the push service before giving up on this one. */
  timeoutMs: number
}

export async function sendWebPush(
  subscription: PushSubscriptionKeys,
  payload: string,
  vapid: { keys: VapidKeys; subject: string },
  options: PushOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<PushOutcome> {
  if (!isAllowedPushEndpoint(subscription.endpoint)) return { ok: false, status: 0, gone: true }
  const body = encryptPayload(Buffer.from(payload, 'utf8'), subscription)
  const response = await fetchImpl(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuthorization(subscription.endpoint, vapid.keys, vapid.subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(options.ttlSeconds),
      Urgency: options.urgency,
    },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(options.timeoutMs),
    redirect: 'error',
  })
  // Drained rather than left hanging, so the connection goes back to the pool.
  await response.arrayBuffer().catch(() => undefined)
  return {
    ok: response.ok,
    status: response.status,
    gone: response.status === 404 || response.status === 410,
  }
}
