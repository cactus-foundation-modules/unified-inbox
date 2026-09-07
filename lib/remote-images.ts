import { lookup } from 'node:dns/promises'
import { REMOTE_SRC_ATTR } from './html'
import { isDisplayableImageType } from './inline-images'
import { isOpenBeacon } from './tracking-beacons'

// ---------------------------------------------------------------------------
// Showing the pictures in an email, once somebody has asked to see them.
//
// The sync engine parks every remote image address on a data attribute and
// leaves the tag with no src (see lib/html.ts), so opening a message fetches
// nothing from the sender's server. This file is the other half: what happens
// when the reader presses "Show pictures".
//
// The pictures are NOT simply put back. Two reasons, and the second is the one
// that decides it:
//
//   Privacy. A tracking pixel fetched by the reader's browser hands the sender
//   the reader's address, their rough location and the moment they opened it.
//   Fetched here, the sender learns that the site looked - which they would
//   learn anyway - and nothing about the person who did.
//
//   The site's own content policy. Admin pages allow images from this origin
//   and the media store, and nowhere else. That is deliberate and no module may
//   widen it: a policy that allows images from anywhere on earth is not a
//   policy. So the picture has to arrive from this origin or not at all.
//
// The address is never taken from the request. The route is asked for the Nth
// picture in a stored message and finds the address itself, so the worst an
// attacker can do is ask us to fetch something they already emailed us - and
// the checks below decide whether even that is allowed.
// ---------------------------------------------------------------------------

const REMOTE_ATTR_RE = new RegExp(`${REMOTE_SRC_ATTR}="([^"]*)"`, 'gi')

/** Every parked image address in a stored message, in the order they appear.
 *  Order is the whole contract with the route: it asks for number three and
 *  gets the third picture in the message it named. */
export function remoteImageUrls(html: string | null | undefined): string[] {
  if (!html) return []
  const out: string[] = []
  for (const match of html.matchAll(REMOTE_ATTR_RE)) {
    out.push(decodeEntities(match[1] ?? ''))
  }
  return out
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** The parked addresses that are worth offering to show, which is every one of
 *  them bar the sending service's own counters. Used for the count on the
 *  screen: a message whose only remote picture is an open beacon has nothing to
 *  show, and offering "Show pictures" for it is a button that does nothing. */
export function showableRemoteImageUrls(html: string | null | undefined): string[] {
  return remoteImageUrls(html).filter((url) => !isOpenBeacon(url))
}

/**
 * Put the pictures back, pointed at this site rather than at the sender.
 *
 * `hrefFor(index)` decides the address - the route that fetches picture number
 * `index` of this message. Anything the fetcher later refuses simply fails to
 * load, which looks like a broken image and costs nothing else.
 *
 * Except a counter, which is left exactly where it was found. Showing the
 * pictures in a message we sent is not a decision to tell Brevo the recipient
 * read it, and the frame's own policy allows nothing without a src - so a
 * beacon left parked makes no request from either side. The index still
 * advances over it: the numbering is the whole contract with the picture route,
 * and it is read off the same list.
 */
export function restoreRemoteImages(html: string, hrefFor: (index: number) => string): string {
  const urls = remoteImageUrls(html)
  let index = -1
  return html.replace(REMOTE_ATTR_RE, (match) => {
    index += 1
    if (isOpenBeacon(urls[index] ?? '')) return match
    return `src="${hrefFor(index).replace(/"/g, '&quot;')}"`
  })
}

/** How much of a picture is worth carrying. Beyond this it is not a picture in
 *  an email, it is somebody using the site as a file host. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** Address ranges that are not out on the internet at all: the machine itself,
 *  the private networks a host sits on, and the link-local address cloud
 *  providers answer their own metadata on. Fetching one of those on somebody
 *  else's say-so is how a server is talked into reading its own secrets. */
function isPrivateAddress(address: string, family: number): boolean {
  if (family === 6) {
    const v6 = address.toLowerCase()
    if (v6 === '::1' || v6 === '::') return true
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true
    if (v6.startsWith('fe80')) return true
    // An IPv4 address wearing a v6 hat still goes wherever the v4 one went.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)
    if (mapped) return isPrivateAddress(mapped[1]!, 4)
    return false
  }
  const parts = address.split('.').map((n) => parseInt(n, 10))
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true
  const [a, b] = parts as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a >= 224) return true
  return false
}

export type ImageFetchResult =
  | { ok: true; bytes: Uint8Array; contentType: string }
  | { ok: false; reason: string }

/**
 * Fetch one picture, defensively.
 *
 * https only, a host that resolves to somewhere on the public internet, a
 * content type that is genuinely an image, a size ceiling, and a short timeout.
 * Redirects are followed by hand so every hop is checked rather than only the
 * first - a permissive first hop pointing at 169.254.169.254 is the whole of
 * the attack.
 *
 * The sending service's own counters are refused outright, wherever the address
 * came from and whoever asked. The frame above no longer points at them, and
 * this is the second lock on that door: the picture route works off a position
 * in the stored message, so the number of a beacon can still be asked for by
 * hand. Checked on every hop as well - a redirect INTO a counter counts just
 * the same as being sent straight at one.
 */
export async function fetchRemoteImage(rawUrl: string, hops = 3): Promise<ImageFetchResult> {
  if (isOpenBeacon(rawUrl)) {
    return { ok: false, reason: 'That is the email service counting who opened the message, not a picture.' }
  }
  let url: URL
  try {
    url = new URL(rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl)
  } catch {
    return { ok: false, reason: 'That picture address does not make sense.' }
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'Pictures are only fetched over a secure connection.' }
  }
  try {
    const resolved = await lookup(url.hostname, { all: true })
    if (resolved.length === 0) return { ok: false, reason: 'That address does not resolve.' }
    if (resolved.some((r) => isPrivateAddress(r.address, r.family))) {
      return { ok: false, reason: 'That address points back at this network.' }
    }
  } catch {
    return { ok: false, reason: 'That address does not resolve.' }
  }

  let response: Response
  try {
    response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(8_000),
      headers: { Accept: 'image/*' },
    })
  } catch {
    return { ok: false, reason: 'That picture could not be fetched.' }
  }

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location')
    if (!location || hops <= 0) return { ok: false, reason: 'That picture moved too many times.' }
    return fetchRemoteImage(new URL(location, url).toString(), hops - 1)
  }
  if (!response.ok) return { ok: false, reason: 'That picture is no longer there.' }

  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  // One allow-list for every picture this module serves, wherever it came from
  // - see lib/inline-images.ts. SVG is markup with script in it and is not on it.
  if (!isDisplayableImageType(contentType)) {
    return { ok: false, reason: 'That is not a picture.' }
  }
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > MAX_IMAGE_BYTES) return { ok: false, reason: 'That picture is too big.' }

  const buffer = new Uint8Array(await response.arrayBuffer())
  if (buffer.byteLength > MAX_IMAGE_BYTES) return { ok: false, reason: 'That picture is too big.' }
  return { ok: true, bytes: buffer, contentType }
}
