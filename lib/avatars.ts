import { createHash } from 'node:crypto'
import { lookup, resolveSrv } from 'node:dns/promises'
import { isIP } from 'node:net'

// Somebody's own picture, if they have published one.
//
// Gravatar and Libravatar both work the same way: hash an email address, ask
// for the picture filed under that hash, and get a 404 when there is none. The
// address itself never leaves the site - a SHA-256 is one way - and neither
// does the hash, because every request is made from the server and the picture
// is streamed back through our own origin. So the browser only ever sees an
// address like /api/m/unified-inbox/avatar/person/<id>, no third party learns
// which of our staff is reading their mail or from what IP, and no CSP origin
// has to be opened up. That is the same shape core already uses for member
// avatars (app/api/members/avatar-proxy) and it is here for the same reasons.
//
// SHA-256 only. Both services file an account under the MD5 AND the SHA-256 of
// the same address, so trying the older hash as well would be a fourth round
// trip per person that can never find anything the third did not.
//
// OFF UNTIL SOMEBODY SWITCHES IT ON. Asking a third party whether it holds a
// picture for a customer's address tells that third party we hold the address,
// and this module's own settings already take that line about read receipts:
// tracking does not arrive with an update.

/** How long a DNS answer is trusted for. Federation records change about as
 *  often as a company changes mail host, and a miss is by far the common case,
 *  so both answers are kept. */
const SRV_TTL_MS = 60 * 60 * 1000
/** Nothing waits on a stranger's server for longer than this. Three tries at
 *  four seconds is the worst case for one picture, and the picture is a
 *  decoration on a row that has already rendered. */
const FETCH_TIMEOUT_MS = 4000
/** An avatar is a small square. Anything claiming to be more than this is not
 *  one, and is not read into memory to find out. */
const MAX_BYTES = 512 * 1024

/** Trim and fold case, which is the address both services hash. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** The one hash both services file an account under. */
export function emailHash(email: string): string {
  return createHash('sha256').update(normaliseEmail(email)).digest('hex')
}

/** The domain half, or null for anything that is not one address. */
export function domainOf(email: string): string | null {
  const at = normaliseEmail(email).lastIndexOf('@')
  if (at <= 0) return null
  const domain = normaliseEmail(email).slice(at + 1)
  // A bare label ("localhost"), an address literal or anything with a space in
  // it is not a domain we will look up.
  if (!domain.includes('.') || /[^a-z0-9.-]/.test(domain)) return null
  return domain
}

/**
 * Whether an IP address is one out on the internet.
 *
 * This is the guard that makes federation safe to have at all. A federated
 * avatar host comes out of DNS records belonging to WHOEVER SENT US MAIL, so a
 * stranger who owns a domain can point one at anything they like - the
 * machine's own loopback, the private network the site is deployed into, or a
 * cloud provider's metadata endpoint at 169.254.169.254, which is where the
 * credentials are. Refusing to fetch from anything that is not a public address
 * is what turns "we will ask their server" into something safe to do.
 */
export function isPublicAddress(ip: string): boolean {
  const version = isIP(ip)
  if (version === 4) {
    const parts = ip.split('.').map(Number)
    const [a, b] = parts as [number, number, number, number]
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
    if (a === 0 || a === 10 || a === 127) return false            // this network, private, loopback
    if (a === 169 && b === 254) return false                       // link local, and the metadata endpoint
    if (a === 172 && b >= 16 && b <= 31) return false              // private
    if (a === 192 && b === 168) return false                       // private
    if (a === 192 && b === 0) return false                         // protocol assignments
    if (a === 100 && b >= 64 && b <= 127) return false             // carrier grade NAT
    if (a === 198 && (b === 18 || b === 19)) return false           // benchmarking
    if (a >= 224) return false                                      // multicast and reserved
    return true
  }
  if (version === 6) {
    const flat = ip.toLowerCase()
    if (flat === '::' || flat === '::1') return false
    // An IPv4 address wearing an IPv6 coat answers to the rules above.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(flat)
    if (mapped) return isPublicAddress(mapped[1]!)
    const head = parseInt(flat.split(':')[0] || '0', 16)
    if ((head & 0xfe00) === 0xfc00) return false                    // unique local
    if ((head & 0xffc0) === 0xfe80) return false                    // link local
    return true
  }
  return false
}

/** Whether every address a name resolves to is out on the internet. A name that
 *  does not resolve at all is refused too: there is nothing to fetch from. */
async function resolvesPublicly(host: string): Promise<boolean> {
  try {
    const addresses = await lookup(host, { all: true })
    return addresses.length > 0 && addresses.every((a) => isPublicAddress(a.address))
  } catch {
    return false
  }
}

export type SrvRecord = { name: string; port: number; priority: number; weight: number }

/** Which record to use, of the several a domain may publish: lowest priority
 *  wins, and the heaviest of those. The spec asks for a weighted random pick
 *  among equals; taking the heaviest is deterministic, which means the answer
 *  can be cached and two page loads agree with each other. */
export function pickSrv(records: SrvRecord[]): SrvRecord | null {
  const usable = records.filter((r) => r.name && r.port > 0 && r.port <= 65535)
  if (usable.length === 0) return null
  return usable.reduce((best, r) => {
    if (r.priority !== best.priority) return r.priority < best.priority ? r : best
    return r.weight > best.weight ? r : best
  })
}

/** Where one host's avatars live, as an address to fetch. */
export function federatedUrl(host: string, port: number, hash: string, size: number): string {
  const authority = port === 443 ? host : `${host}:${port}`
  return `https://${authority}/avatar/${hash}?s=${size}&d=404`
}

const srvCache = new Map<string, { value: { host: string; port: number } | null; at: number }>()

/**
 * Where a domain says its own avatars live, or null when it runs none - which
 * is almost every domain.
 *
 * Only `_avatars-sec._tcp`, the https record. Libravatar also defines a plain
 * `_avatars._tcp` on port 80, and fetching a stranger's picture over an
 * unencrypted connection from a server that holds a customer mailbox is not a
 * trade anybody here is making for a decoration.
 */
export async function federatedHost(domain: string): Promise<{ host: string; port: number } | null> {
  const cached = srvCache.get(domain)
  if (cached && Date.now() - cached.at < SRV_TTL_MS) return cached.value

  let value: { host: string; port: number } | null = null
  try {
    const chosen = pickSrv(await resolveSrv(`_avatars-sec._tcp.${domain}`))
    if (chosen && await resolvesPublicly(chosen.name)) {
      value = { host: chosen.name, port: chosen.port }
    }
  } catch {
    // No record, no such domain, no working resolver - all the same answer, and
    // all of them the common case.
    value = null
  }
  srvCache.set(domain, { value, at: Date.now() })
  return value
}

/**
 * Every address worth asking, in order: the sender's own domain if it runs a
 * Libravatar of its own, then Libravatar's, then Gravatar's.
 *
 * `d=404` on all of them, which is what makes the chain work at all: without it
 * each service answers with a generated pattern and the first one always
 * "succeeds".
 */
export async function avatarSources(email: string, size: number): Promise<string[]> {
  const hash = emailHash(email)
  const sources: string[] = []
  const domain = domainOf(email)
  if (domain) {
    const own = await federatedHost(domain)
    if (own) sources.push(federatedUrl(own.host, own.port, hash, size))
  }
  sources.push(`https://seccdn.libravatar.org/avatar/${hash}?s=${size}&d=404`)
  sources.push(`https://www.gravatar.com/avatar/${hash}?s=${size}&d=404`)
  return sources
}

export type AvatarHit = { body: ArrayBuffer; contentType: string }

/**
 * The first picture anybody has for this address, or null when nobody has one.
 *
 * Everything that comes back is treated as a stranger's bytes: it has to claim
 * to be an image, it has to be small, and it is served on from the route with
 * `nosniff` so a browser cannot decide it is markup after all.
 */
export async function fetchAvatar(email: string, size: number): Promise<AvatarHit | null> {
  if (!domainOf(email)) return null
  for (const url of await avatarSources(email, size)) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
        headers: { Accept: 'image/*' },
      })
      if (!response.ok) continue
      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.startsWith('image/')) continue
      const declared = Number(response.headers.get('content-length') ?? '0')
      if (declared > MAX_BYTES) continue
      const body = await response.arrayBuffer()
      if (body.byteLength === 0 || body.byteLength > MAX_BYTES) continue
      return { body, contentType }
    } catch {
      // A timeout, a refused connection, a certificate nobody renewed. Try the
      // next one; a picture is not worth an error on the screen.
      continue
    }
  }
  return null
}
