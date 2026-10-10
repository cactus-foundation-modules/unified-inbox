// The people layer, in its pure form: everything that decides who somebody is
// without needing a database to say it.
//
// Thin on purpose (D15). Identities, a name, and an organisation worked out
// from the mail domain. There is nothing else in here and nothing else belongs
// in here - the moment this file grows a stage, a score or a pipeline it has
// stopped being the thing the plan asked for and started being a CRM.

import { toE164 } from '@/lib/phone'

/**
 * Free mail providers. An address at one of these tells you about the person's
 * mailbox and nothing whatever about who they work for, so a domain on this
 * list never becomes an organisation and never counts as one of the site's own
 * domains however the inboxes are set up.
 *
 * Not exhaustive and never will be, which is why a site can add to it in
 * settings. Getting it wrong in this direction is cheap: one person keeps an
 * organisation they should not have had, and it can be cleared in a click.
 */
export const CONSUMER_DOMAINS: readonly string[] = [
  'gmail.com', 'googlemail.com',
  'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'live.co.uk', 'msn.com',
  'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'rocketmail.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'aol.co.uk',
  'btinternet.com', 'sky.com', 'talktalk.net', 'virginmedia.com', 'blueyonder.co.uk',
  'ntlworld.com', 'tiscali.co.uk', 'plus.net', 'plusnet.com',
  'protonmail.com', 'proton.me', 'pm.me',
  'gmx.com', 'gmx.co.uk', 'gmx.net', 'web.de', 'mail.com', 'zoho.com',
  'fastmail.com', 'fastmail.fm', 'hey.com', 'yandex.com', 'yandex.ru',
  'qq.com', '163.com', '126.com',
]

const CONSUMER_SET = new Set(CONSUMER_DOMAINS)

/**
 * Second-level suffixes that are part of the registry rather than part of
 * anybody's name. Without these, `deskwell.co.uk` reads as an organisation
 * called "Co" and every British company on the site shares one.
 */
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'ac.uk', 'gov.uk', 'nhs.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'net.nz', 'org.nz',
  'co.za', 'com.br', 'com.mx', 'co.in', 'co.jp', 'com.sg', 'com.hk',
])

/** The domain half of an address, lower case, or null if there is not one. */
export function domainOf(address: string | null | undefined): string | null {
  if (!address) return null
  const at = address.lastIndexOf('@')
  if (at < 0 || at === address.length - 1) return null
  const domain = address.slice(at + 1).trim().toLowerCase()
  return domain || null
}

/**
 * What "have we met this person before?" compares on: the address lower cased,
 * with any plus tag taken off the local part.
 *
 * The tag is stripped for MATCHING only. The address we actually hold keeps it,
 * because `chris+shop@example.com` was given to us on purpose and replying to
 * the bare form throws away whatever the person was sorting their own mail by.
 */
export function identityKey(address: string | null | undefined): string | null {
  if (!address) return null
  const trimmed = address.trim().toLowerCase()
  const at = trimmed.lastIndexOf('@')
  if (at <= 0 || at === trimmed.length - 1) return null
  const local = trimmed.slice(0, at)
  const domain = trimmed.slice(at + 1)
  const plus = local.indexOf('+')
  const bare = plus > 0 ? local.slice(0, plus) : local
  if (!bare) return null
  return `${bare}@${domain}`
}

/**
 * A phone number the way the address book writes it down: one shape, so a
 * number typed six ways is one number on the card and one identity.
 *
 * A number in the site's own country (Settings > General, dialling code) is
 * written nationally, trunk zero and digits, no spaces - `+44 7311 351565`,
 * `0044 7311 351565`, `+44 (0)7311 351565` and `07311 351565` all become
 * `07311351565`. A number from anywhere else keeps its country code, again
 * with no spaces: `+33 1 23 45 67 89` becomes `+33123456789`. North America has
 * no trunk zero, so a +1 site's own numbers are the ten digits.
 *
 * Something that cannot be read as a number at all keeps its digits (and a
 * leading +); fewer than six of them is not a phone number and comes back null.
 */
export function tidyPhone(value: string | null | undefined, diallingCode: string): string | null {
  if (!value) return null
  const trimmed = value.trim()
  const e164 = toE164(trimmed, diallingCode)
  if (e164) {
    const code = diallingCode.replace(/\D/g, '').replace(/^00/, '')
    if (code && e164.startsWith(`+${code}`)) {
      // `.replace(/^0+/, '')` because `+44 (0)7311...` arrives as +4407311...
      const national = e164.slice(code.length + 1).replace(/^0+/, '')
      return code === '1' ? national : `0${national}`
    }
    return e164
  }
  const digits = trimmed.replace(/\D+/g, '')
  if (digits.length < 6) return null
  return trimmed.startsWith('+') ? `+${digits}` : digits
}

/** What a number is matched on. The tidied number itself, so the matching key
 *  and what the card shows can never disagree about who holds a number. */
export function phoneKey(value: string | null | undefined, diallingCode: string): string | null {
  return tidyPhone(value, diallingCode)
}

export function isPersonalDomain(domain: string | null, extra: readonly string[] = []): boolean {
  if (!domain) return false
  if (CONSUMER_SET.has(domain)) return true
  return extra.some((d) => d.trim().toLowerCase() === domain)
}

/**
 * The domains that mean "one of us" (E18).
 *
 * An explicit list in settings wins outright, including an empty one - a site
 * that has cleared the box has said something and should be believed. Otherwise
 * it is worked out from the addresses the site collects mail on, which is right
 * for anybody who has not thought about it: if `hi@deskwell.co.uk` is one of
 * our inboxes then `marcus@deskwell.co.uk` is a colleague, not a customer.
 *
 * A free provider is never inferred this way. A site whose only inbox is a
 * Gmail address would otherwise stop recognising every Gmail correspondent it
 * has, which is the whole customer list on some sites.
 */
export function resolveOwnDomains(
  inboxAddresses: readonly string[],
  configured: readonly string[] | null,
  personalDomains: readonly string[] = [],
): string[] {
  if (configured !== null) {
    return unique(configured.map((d) => d.trim().toLowerCase()).filter(Boolean))
  }
  const inferred = inboxAddresses
    .map((a) => domainOf(a))
    .filter((d): d is string => !!d && !isPersonalDomain(d, personalDomains))
  return unique(inferred)
}

export type PersonGate = {
  /** Every address the site collects mail on, normalised. */
  ownAddresses: ReadonlySet<string>
  /** Every staff account's own email address, normalised. */
  staffAddresses: ReadonlySet<string>
  /** Domains that mean "one of us", from resolveOwnDomains. */
  ownDomains: readonly string[]
  /** Addresses the site has blocked, exactly as blocked (lower case, trimmed,
   *  any `+tag` kept). Blocking somebody takes them out of the address book,
   *  and this is what stops the next pass putting them straight back. Optional
   *  because only the gates that MINT people need it - the one deciding whether
   *  a message is our own has no use for it. */
  blockedAddresses?: ReadonlySet<string>
}

/**
 * Whether an address should become a person at all (E18).
 *
 * Our own inboxes, our own staff and anybody at one of our own domains are not
 * customers, and minting a person for each of them turns the colleague who
 * forwards a supplier email into a contact record. The address is still stored
 * on the message either way - this decides only whether a person is created.
 */
export function shouldBecomePerson(address: string | null, gate: PersonGate): boolean {
  const key = identityKey(address)
  if (!key) return false
  if (address && gate.blockedAddresses?.has(address.trim().toLowerCase())) return false
  if (gate.ownAddresses.has(key)) return false
  if (gate.staffAddresses.has(key)) return false
  const domain = domainOf(key)
  if (domain && gate.ownDomains.includes(domain)) return false
  // Anything that looks like the mail system talking rather than a person.
  const local = key.slice(0, key.indexOf('@'))
  if (NON_HUMAN_LOCAL_PARTS.has(local)) return false
  return true
}

/**
 * Whether a message came from us rather than from a stranger - the same "one of
 * us" question as shouldBecomePerson (E18), asked about a message instead of an
 * address.
 *
 * It decides whether the pictures in a message are held back until somebody
 * asks. Holding them back protects the reader from a tracking pixel in a
 * stranger's email; there is nothing to protect anybody from in our own signature
 * logo, and warning about one on every reply we ever sent taught people to press
 * the button without reading it, which is worse than not warning at all.
 *
 * Anything we sent is ours by definition, notes included - a note never left the
 * building. An inbound message is ours when the address it came from is one of
 * our inboxes, a colleague's, or at one of our own domains: a colleague
 * forwarding a supplier's email is the ordinary case.
 *
 * From is what decides it, not Reply-To. Reply-To is set by whoever sent the
 * message and says where they would like an answer, so treating it as proof of
 * who they are would let anybody claim to be us. From can be forged too, and a
 * stranger who forges our own domain gets their pictures loaded - which is the
 * cost of the setting, and small next to the tracking they would have got from
 * the reader pressing the button on a message that appeared to come from a
 * colleague.
 */
export function isOwnSender(
  message: { direction: 'in' | 'out' | 'note'; fromAddress: string | null },
  gate: PersonGate,
): boolean {
  if (message.direction !== 'in') return true
  const key = identityKey(message.fromAddress)
  if (!key) return false
  if (gate.ownAddresses.has(key)) return true
  if (gate.staffAddresses.has(key)) return true
  const domain = domainOf(key)
  return !!domain && gate.ownDomains.includes(domain)
}

/**
 * Local parts that are a machine rather than somebody with a desk. A person
 * record for `mailer-daemon` or `no-reply` is never useful and clutters every
 * list it appears in. Role addresses like `accounts@` are deliberately NOT
 * here: they are several humans behind one address, which collapses to one
 * person by design (E19), and that is documented rather than worked around.
 */
const NON_HUMAN_LOCAL_PARTS = new Set([
  'mailer-daemon', 'postmaster', 'no-reply', 'noreply', 'donotreply', 'do-not-reply',
  'bounce', 'bounces', 'notifications', 'notification', 'automated',
])

/**
 * A name for somebody we have only ever seen an address for.
 *
 * A display name from the mail header wins whenever there is one. Otherwise the
 * local part, tidied: `jane.smith` reads better as "Jane Smith" than as itself,
 * and a person nobody can recognise in a list is a person nobody uses.
 */
export function displayNameFor(headerName: string | null, address: string | null): string | null {
  const trimmed = headerName?.trim() ?? ''
  // A display name that is just the address again tells us nothing.
  if (trimmed && trimmed.toLowerCase() !== (address ?? '').toLowerCase()) return trimmed
  const key = identityKey(address)
  if (!key) return null
  const local = key.slice(0, key.indexOf('@'))
  const words = local.split(/[._-]+/).filter(Boolean)
  // A local part with no separators and no vowels-and-letters shape is somebody
  // random's mailbox name, and title casing it invents a person called "Ab12cd".
  if (words.length === 0) return null
  if (words.length === 1 && !/^[a-z]+$/.test(words[0]!)) return null
  return words.map(titleCaseWord).join(' ')
}

function titleCaseWord(word: string): string {
  if (!word) return word
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/**
 * An organisation name guessed from a mail domain, or null when guessing would
 * be wrong. A free provider is never an organisation - "Gmail" is not a company
 * anybody at this site does business with.
 */
export function organisationNameFromDomain(
  domain: string | null,
  personalDomains: readonly string[] = [],
): string | null {
  if (!domain) return null
  if (isPersonalDomain(domain, personalDomains)) return null
  const clean = domain.replace(/^www\./, '')
  const parts = clean.split('.')
  if (parts.length < 2) return null
  const lastTwo = parts.slice(-2).join('.')
  const name = MULTI_PART_SUFFIXES.has(lastTwo)
    ? parts[parts.length - 3]
    : parts[parts.length - 2]
  if (!name) return null
  return name.split(/[-_]+/).filter(Boolean).map(titleCaseWord).join(' ') || null
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

/**
 * The name to show for whoever a conversation is with: the one on their
 * contact card where the message itself has none worth showing.
 *
 * A call or a text carries the caller's number in the name slot, and an email
 * can arrive with no display name at all - so a conversation with somebody the
 * address book knows perfectly well read "07445164570" in the list and in its
 * header. A real name on the message still wins: it is what they called
 * themselves, today, and it is what the row has always shown. The card only
 * fills the gap - and only with a name, since an automatic card for a caller
 * is itself named after the number.
 */
export function preferContactName(messageName: string | null | undefined, contactName: string | null | undefined): string | null {
  const own = messageName?.trim() || null
  const card = contactName?.trim() || null
  if (own && isRealName(own)) return own
  if (card && isRealName(card)) return card
  return own
}

/** Whether a name is a name rather than a number or an address standing in for one. */
function isRealName(name: string): boolean {
  return /\p{L}/u.test(name) && !name.includes('@')
}

