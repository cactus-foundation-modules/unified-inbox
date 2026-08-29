// Address handling, kept pure and away from the database so the rules that
// decide which inbox a message belongs to can be tested without one.
//
// Everything stored is normalised: lower case, no display name, no angle
// brackets. Mail servers treat the local part as case sensitive in theory and
// nobody does in practice, and a routing table that disagrees with itself about
// Hi@ and hi@ sends a customer's email to the catch-all.

/** `"Marcus Brown" <Marcus@Deskwell.co.uk>` becomes `marcus@deskwell.co.uk`. */
export function normaliseAddress(input: string): string {
  const trimmed = input.trim()
  const angled = trimmed.match(/<([^>]+)>/)
  return (angled ? angled[1]! : trimmed).trim().toLowerCase()
}

/** Splits a header value that may carry several addresses. Quoted display
 *  names can contain commas, so the split has to know about quotes. */
export function parseAddressList(input: string | null | undefined): string[] {
  if (!input) return []
  const parts: string[] = []
  let current = ''
  let inQuotes = false
  for (const char of input) {
    if (char === '"') inQuotes = !inQuotes
    if (char === ',' && !inQuotes) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts.map(normaliseAddress).filter((a) => a.length > 0)
}

/** The domain half, for grouping people into an organisation. */
export function addressDomain(address: string): string | null {
  const at = normaliseAddress(address).lastIndexOf('@')
  if (at < 1) return null
  const domain = normaliseAddress(address).slice(at + 1)
  return domain.length > 0 ? domain : null
}

export function isValidAddress(input: string): boolean {
  const address = normaliseAddress(input)
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(address)
}

export type RoutableInbox = { id: string; address: string; isCatchAll: boolean }

export type RoutingDecision = {
  inboxId: string | null
  /** Which header settled it, for the "why did this land here?" question that
   *  always follows a message turning up in the wrong place. */
  matchedOn: 'delivered-to' | 'to' | 'cc' | 'from' | 'catch-all' | 'none'
}

/**
 * Which inbox a message belongs to (D11): the delivered-to address wins, then
 * the To line, then the Cc line, then the catch-all. Nothing else - no sender
 * rules, no subject rules, and no guessing.
 */
export function routeToInbox(
  headers: { deliveredTo?: string[]; to?: string[]; cc?: string[] },
  inboxes: RoutableInbox[]
): RoutingDecision {
  const byAddress = new Map(inboxes.map((i) => [normaliseAddress(i.address), i]))
  const passes: Array<[RoutingDecision['matchedOn'], string[]]> = [
    ['delivered-to', headers.deliveredTo ?? []],
    ['to', headers.to ?? []],
    ['cc', headers.cc ?? []],
  ]
  for (const [matchedOn, addresses] of passes) {
    for (const address of addresses) {
      const inbox = byAddress.get(normaliseAddress(address))
      if (inbox) return { inboxId: inbox.id, matchedOn }
    }
  }
  const catchAll = inboxes.find((i) => i.isCatchAll)
  return catchAll
    ? { inboxId: catchAll.id, matchedOn: 'catch-all' }
    : { inboxId: null, matchedOn: 'none' }
}

/**
 * Which inbox a message we SENT belongs to. The From line decides it: a reply
 * sent as marcus@ belongs to marcus@ whoever it went to, and the recipient is a
 * customer's address that matches no inbox at all. Only when the From line is
 * an address we do not serve does this fall back to the ordinary inbound rules,
 * which is the case where the owner sent something from a personal address
 * through the same account.
 */
export function routeSentToInbox(
  fromAddresses: string[],
  headers: { deliveredTo?: string[]; to?: string[]; cc?: string[] },
  inboxes: RoutableInbox[]
): RoutingDecision {
  const byAddress = new Map(inboxes.map((i) => [normaliseAddress(i.address), i]))
  for (const address of fromAddresses) {
    const inbox = byAddress.get(normaliseAddress(address))
    if (inbox) return { inboxId: inbox.id, matchedOn: 'from' }
  }
  return routeToInbox(headers, inboxes)
}

/**
 * Whether a message is dropped unread rather than filed with no inbox.
 *
 * A pure function with a test beside it, rather than three clauses buried in
 * the middle of the reader, because this is the only place in the module that
 * throws a customer's words away at the moment it reads them, and the argument
 * for each clause needs somewhere to live.
 *
 * `enabled` is the account's own setting and is off unless somebody turned it
 * on. `inboxId` null means the message is addressed to none of this site's
 * addresses and there is no catch-all to sweep it up. `threadId` null means it
 * starts a conversation rather than joining one - and that clause is the whole
 * safety of the thing: a third party brought into a thread already held, or an
 * address appearing in nothing but a Bcc, routes nowhere too, and dropping
 * those would leave a conversation reading as though somebody stopped replying
 * halfway through.
 */
export function shouldDiscardUnrouted(input: {
  enabled: boolean
  inboxId: string | null
  threadId: string | null
}): boolean {
  return input.enabled && input.inboxId === null && input.threadId === null
}
