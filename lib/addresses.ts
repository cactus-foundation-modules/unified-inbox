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
  matchedOn: 'delivered-to' | 'to' | 'cc' | 'from' | 'folder' | 'catch-all' | 'none'
}

/**
 * Which inbox a message belongs to (D11): the delivered-to address wins, then
 * the To line, then the Cc line, then the folder it was found in where that
 * folder has been told it owns its post, then the catch-all. Nothing else - no
 * sender rules, no subject rules, and no guessing.
 *
 * `folderInboxId` is the inbox that reads the folder this message was found in,
 * and only ever set when that inbox has "everything in this folder is mine"
 * turned on. It sits below the address passes deliberately: an email that names
 * one of our addresses outright belongs to that address whichever folder
 * somebody has since dragged it into. It sits above the catch-all for the same
 * reason - a folder somebody files by hand is a stronger statement than a
 * sweep-up rule that was never about this message at all.
 */
export function routeToInbox(
  headers: { deliveredTo?: string[]; to?: string[]; cc?: string[] },
  inboxes: RoutableInbox[],
  folderInboxId?: string | null
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
  if (folderInboxId) {
    const owner = inboxes.find((i) => i.id === folderInboxId)
    if (owner) return { inboxId: owner.id, matchedOn: 'folder' }
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
  inboxes: RoutableInbox[],
  folderInboxId?: string | null
): RoutingDecision {
  const byAddress = new Map(inboxes.map((i) => [normaliseAddress(i.address), i]))
  for (const address of fromAddresses) {
    const inbox = byAddress.get(normaliseAddress(address))
    if (inbox) return { inboxId: inbox.id, matchedOn: 'from' }
  }
  return routeToInbox(headers, inboxes, folderInboxId)
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

/** The header passes that name a recipient outright, as opposed to the
 *  catch-all sweeping up something nobody was named on. */
const NAMED_RECIPIENT: ReadonlyArray<RoutingDecision['matchedOn']> = ['delivered-to', 'to', 'cc']

export type MessagePlacement = {
  direction: 'in' | 'out'
  routing: RoutingDecision
}

/**
 * Which way a message read off the mail server is facing, and whose inbox it
 * belongs in. The two answers are made together because they disagree in
 * exactly one case and that case is the whole reason this function exists.
 *
 * Sitting in a Sent folder settles it: the mail server is stating that this
 * account sent the thing, and a reply to a customer that the owner wrote on
 * their phone has to read as the owner talking however it is addressed. That
 * clause stays.
 *
 * Everywhere else, "the From line is one of ours" is not the same statement.
 * One colleague writing to another is from one of our addresses AND to one of
 * our addresses, and it is post for the person it was addressed to: it arrived
 * in their mailbox, they are the one who has to answer it, and calling it
 * outbound on the sender files it where the recipient will never look and
 * leaves the conversation with no inbound message for a reply audience to be
 * worked out from. So a message found outside a Sent folder, from one of our
 * addresses, and naming a DIFFERENT one of our addresses on Delivered-To, To or
 * Cc, is inbound for that colleague.
 *
 * The sender's own address is struck out of the recipient lists first, so
 * "to: me, cc: emma" still reaches Emma rather than settling on the writer. A
 * message to nobody but ourselves has nothing left after that and stays
 * outbound, which is right: a note to self is something we sent.
 *
 * The catch-all is deliberately not enough. It matches mail nobody here was
 * named on, so treating it as a colleague's post would turn every reply we send
 * a customer into inbound mail for whichever address happens to sweep up.
 */
export function placeMessage(input: {
  /** Whether the copy being read was found in a folder the account sends from. */
  inSentFolder: boolean
  fromAddress: string | null
  /** Every address this account answers to: its inboxes, and the login itself. */
  ownAddresses: Iterable<string>
  headers: { deliveredTo?: string[]; to?: string[]; cc?: string[] }
  inboxes: RoutableInbox[]
  /** The inbox that reads the folder this copy was found in, when that inbox
   *  owns its folder's post. Never enough on its own to make a message somebody
   *  else's post: it is not in NAMED_RECIPIENT, so a message from one of our
   *  own addresses stays outbound and is simply filed where it was found. */
  folderInboxId?: string | null
}): MessagePlacement {
  const from = input.fromAddress ? normaliseAddress(input.fromAddress) : null

  if (input.inSentFolder) {
    return {
      direction: 'out',
      routing: routeSentToInbox(from ? [from] : [], input.headers, input.inboxes, input.folderInboxId),
    }
  }

  const own = new Set(Array.from(input.ownAddresses, normaliseAddress))
  if (from === null || !own.has(from)) {
    return { direction: 'in', routing: routeToInbox(input.headers, input.inboxes, input.folderInboxId) }
  }

  const colleague = routeToInbox(withoutSender(input.headers, from), input.inboxes, input.folderInboxId)
  if (NAMED_RECIPIENT.includes(colleague.matchedOn)) {
    return { direction: 'in', routing: colleague }
  }

  return {
    direction: 'out',
    routing: routeSentToInbox([from], input.headers, input.inboxes, input.folderInboxId),
  }
}

/** One inbox's stake in a message, and which way the message reads from there. */
export type MessageSide = {
  inboxId: string
  /** Relative to THIS inbox, not to the site: the same email is something
   *  Marcus sent and something Chris received. */
  direction: 'in' | 'out'
}

/**
 * Every inbox with a stake in a message, when the message is between two of our
 * own addresses.
 *
 * One email, two conversations. `placeMessage` above answers "whose post is
 * this?" with a single inbox, which is the right question for a customer's mail
 * and the wrong one for a colleague's: mail from marcus@ to chris@ is Marcus's
 * sent message AND Chris's received one, and each of them needs their own
 * conversation to mark done, snooze and answer, exactly as they would with a
 * customer. Filing it once leaves whichever of them lost the toss looking at a
 * tab where the message is not.
 *
 * Returns nothing at all unless at least two distinct inboxes are involved, so
 * every ordinary customer email walks straight past this and is filed once, the
 * way it always was.
 *
 * The catch-all is deliberately not consulted, for the same reason it is not
 * consulted in `placeMessage`: it matches mail nobody here was named on, and
 * treating that as a colleague's post would mint a second conversation out of
 * every reply the site sends a customer.
 */
export function internalSides(input: {
  fromAddress: string | null
  headers: { deliveredTo?: string[]; to?: string[]; cc?: string[] }
  inboxes: RoutableInbox[]
}): MessageSide[] {
  const from = input.fromAddress ? normaliseAddress(input.fromAddress) : null
  if (!from) return []

  const byAddress = new Map(input.inboxes.map((i) => [normaliseAddress(i.address), i]))
  const sender = byAddress.get(from)
  if (!sender) return []

  const sides: MessageSide[] = [{ inboxId: sender.id, direction: 'out' }]
  const seen = new Set<string>([sender.id])

  const recipients = [
    ...(input.headers.deliveredTo ?? []),
    ...(input.headers.to ?? []),
    ...(input.headers.cc ?? []),
  ]
  for (const address of recipients) {
    const inbox = byAddress.get(normaliseAddress(address))
    if (!inbox || seen.has(inbox.id)) continue
    seen.add(inbox.id)
    sides.push({ inboxId: inbox.id, direction: 'in' })
  }

  // Only ourselves on both ends counts as internal. A note to self has one side
  // and is simply something we sent.
  return sides.length > 1 ? sides : []
}

function withoutSender(
  headers: { deliveredTo?: string[]; to?: string[]; cc?: string[] },
  sender: string,
): { deliveredTo: string[]; to: string[]; cc: string[] } {
  const drop = (list: string[] | undefined): string[] =>
    (list ?? []).filter((address) => normaliseAddress(address) !== sender)
  return {
    deliveredTo: drop(headers.deliveredTo),
    to: drop(headers.to),
    cc: drop(headers.cc),
  }
}
