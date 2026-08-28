// The people layer, in its pure form: everything that decides who somebody is
// without needing a database to say it.
//
// Thin on purpose (D15). Identities, a name, and an organisation worked out
// from the mail domain. There is nothing else in here and nothing else belongs
// in here - the moment this file grows a stage, a score or a pipeline it has
// stopped being the thing the plan asked for and started being a CRM.

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

/** Digits only, so a number written six ways is one identity. A leading + is
 *  kept because it is the difference between a country code and an area code. */
export function phoneKey(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  const plus = trimmed.startsWith('+')
  const digits = trimmed.replace(/\D+/g, '')
  if (digits.length < 6) return null
  return plus ? `+${digits}` : digits
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
