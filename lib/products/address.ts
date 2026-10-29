// A product page's address, taken back apart into the slug that names it.
//
// The other half of productPage() in ./shop.ts: that builds an address out of a
// slug, this reads one. It is what lets somebody paste the link they have open
// in another tab and get the same block the catalogue picker would have given
// them, rather than an underlined address.
//
// Pure string work with no database and no DOM, so it is tested on its own and
// the source only has to ask the shop about a slug it already believes in.
//
// Only this site's own pages. A link to somebody else's shop is a link, and
// guessing that their slug means one of our products would quote a customer the
// wrong thing with our name on it. "www." is ignored on both sides, because a
// site reachable at both is one site.

function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '')
}

/**
 * The slug a product address points at, or null when it is not one.
 *
 * `/shop/products/<slug>` is read whatever the shop's setting, because that is
 * where every product page lived before the setting existed and old links still
 * get pasted. A bare `/<slug>` is only read on a shop that publishes its products
 * there - on any other, a single word after the domain is a page, not a product.
 * The query string and the fragment are ignored here: neither one chooses the product (a variation's picks are read by the source).
 */
export function slugFromProductAddress(
  address: string,
  siteUrl: string | null,
  rootStyle: boolean,
): string | null {
  if (!siteUrl) return null
  let url: URL
  let site: URL
  try {
    url = new URL(address.trim())
    site = new URL(siteUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (bareHost(url.hostname) !== bareHost(site.hostname)) return null

  let segments: string[]
  try {
    segments = url.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s))
  } catch {
    return null
  }

  const slug = segments.length === 3 && segments[0] === 'shop' && segments[1] === 'products'
    ? segments[2]
    : rootStyle && segments.length === 1
      ? segments[0]
      : null
  const clean = slug?.trim() ?? ''
  return clean && clean.length <= 300 ? clean : null
}

/** Whether a pasted string is one web address and nothing else - the only
 *  shape worth asking the catalogue about. A sentence with an address in it is
 *  a sentence. */
export function isSingleAddress(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length <= 2000 && /^https?:\/\/\S+$/i.test(trimmed)
}
