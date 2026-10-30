import { createHmac } from 'node:crypto'
import { activeKey, readingKeys, verifyWithAnyKey } from '@/lib/crypto/keyring'
import { normaliseAddress } from '../addresses'

// ---------------------------------------------------------------------------
// Making it stop.
//
// The link at the bottom of every campaign message, and the only part of this
// whole feature with a legal deadline on it: somebody who asks not to be
// written to again has to actually stop being written to, and the asking has to
// work the first time, without a login, for ever.
//
// THE LINK CARRIES A SIGNATURE OF THE ADDRESS, not an id pointing at a row.
// Three things follow from that, and all three matter:
//
//   It keeps working after the campaign is deleted, after the recipient row is
//   pruned, and after the contact has been erased. A link that 404s because
//   somebody tidied up in March is a complaint in April.
//
//   Nobody can unsubscribe anybody else by editing a number in the address bar.
//   The signature is over the address itself, keyed to this site's own
//   ENCRYPTION_KEY, so a token only opts out the address it was made for. New
//   links are signed with the site's active key and checked against every key
//   it has had (core's lib/crypto/keyring.ts), so "for ever" survives a change
//   of key.
//
//   The address is in the link in the clear, which is deliberate: the page has
//   to be able to say WHICH address it is about before somebody confirms, and
//   an opaque token that says "you have been unsubscribed" without saying from
//   what is the pattern every bad mailing list uses.
//
// ONE CLICK, TOO. The `List-Unsubscribe` header with `One-Click` is what Gmail
// and the rest actually look for, and a mail program that offers its own
// unsubscribe button is a mail program whose reader does not press the spam
// button instead. That button POSTs, which is why the route takes both verbs.
// ---------------------------------------------------------------------------

/** Enough signature to be unguessable and short enough to survive a mail
 *  client wrapping the line. 128 bits, base64url. */
const TOKEN_CHARS = 22

/** Why a separate key rather than the encryption key itself: this one is
 *  handed out in every message that leaves, and a value derived for exactly one
 *  purpose cannot be replayed against anything else that shares the secret. */
function subKey(hex: string): Buffer {
  return createHmac('sha256', Buffer.from(hex, 'hex'))
    .update('unified-inbox/campaign-unsubscribe/v1')
    .digest()
}

function tokenWith(hex: string, address: string): string {
  return createHmac('sha256', subKey(hex))
    .update(normaliseAddress(address))
    .digest('base64url')
    .slice(0, TOKEN_CHARS)
}

/** The token for one address. Same address, same token, every time - so a
 *  second campaign to the same person carries the same link, and a link somebody
 *  bookmarked in January still works in June. */
export function unsubscribeToken(address: string): string {
  const hex = activeKey()
  if (!hex) throw new Error('ENCRYPTION_KEY is not set, so campaign unsubscribe links cannot be signed.')
  return tokenWith(hex, address)
}

/** Whether this token really belongs to this address, under any key the site
 *  has had. Compared in constant time, because a token is a credential however
 *  short its life. */
export function tokenMatches(address: string, given: string): boolean {
  if (readingKeys().length === 0) return false
  return verifyWithAnyKey(given, (hex) => tokenWith(hex, address))
}

/**
 * Where the link goes.
 *
 * The campaign id rides along so the confirmation page can say which mailshot
 * this was, and so the suppression row can record where it came from. It is not
 * part of the signature: the opt-out is from every campaign this site will ever
 * send, not from one of them, and a token that only worked for one campaign
 * would be a token that stopped working the day that campaign was deleted.
 */
export function unsubscribeUrl(siteUrl: string, address: string, campaignId?: string | null): string {
  const url = new URL('/api/m/unified-inbox/unsubscribe', siteUrl.replace(/\/$/, ''))
  url.searchParams.set('e', normaliseAddress(address))
  url.searchParams.set('t', unsubscribeToken(address))
  if (campaignId) url.searchParams.set('c', campaignId)
  return url.toString()
}

/** The headers that let a mail program offer its own unsubscribe button. Both
 *  are needed: the second is what tells Gmail the first can be POSTed to
 *  without a human confirming, which is the whole difference between a button
 *  that appears and one that does not. */
export function unsubscribeHeaders(url: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  }
}

export type FooterIdentity = {
  /** What the site is called. */
  siteName: string
  /** Where it is, as typed in settings. Several lines is normal. */
  postalAddress: string | null
}

/**
 * The footer itself.
 *
 * Two jobs, and the second is the one people forget: how to stop, and WHO this
 * is from. A name and a place is what the regulations actually ask for, and it
 * is also what makes the difference between a message that reads as a business
 * writing to you and one that reads as a mailing list that bought your address.
 *
 * Plain and small on purpose. A footer with a logo in it is a footer that looks
 * like marketing, and the entire strategy of this feature is not looking like
 * marketing.
 */
export function unsubscribeFooter(
  url: string,
  identity: FooterIdentity,
): { html: string; text: string } {
  const lines = (identity.postalAddress ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const escaped = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  const place = lines.length > 0 ? `${escaped(identity.siteName)}, ${lines.map(escaped).join(', ')}` : escaped(identity.siteName)
  const placeText = lines.length > 0 ? `${identity.siteName}, ${lines.join(', ')}` : identity.siteName

  const html =
    '<div class="uin-campaign-footer" style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e5e5;font-size:12px;color:#666;line-height:1.5">'
    + `<div>${place}</div>`
    + `<div><a href="${escaped(url)}" style="color:#666">Unsubscribe from these emails</a></div>`
    + '</div>'

  const text = `\n\n--\n${placeText}\nUnsubscribe: ${url}`

  return { html, text }
}
