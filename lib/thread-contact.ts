// Who a conversation is WITH, as somebody here chose it from the people in it.
//
// The line under the subject names one person. Normally that is read off the
// newest message (see InboxPanel), and a merge can pin it to one of the halves
// (migrations/069_thread_contact.sql). This is the third way in: pressing the
// name and picking anybody who actually appears in the conversation - whoever
// wrote in, and whoever we wrote to.
//
// Kept away from the database so the browser offering the list and the route
// checking the answer work it out the same way. The route refuses anything not
// on it, so this cannot be used to label a conversation with a name that
// appears nowhere in it.

export type ThreadContact = {
  name: string | null
  address: string
}

type MessageLike = {
  direction: string
  fromName: string | null
  fromAddress: string | null
  fromPhone?: string | null
  toAddresses: string[]
}

/** One key per address, letter case and stray spaces aside - "SAM@x.com" and
 *  "sam@x.com" are one person to pick, not two. */
export function threadContactKey(address: string): string {
  return address.trim().toLowerCase()
}

/**
 * Everybody on the far end of a conversation, newest first - so the person it
 * is with right now, near enough, leads the list.
 *
 * Senders of anything that came in, and recipients of anything we sent. Notes
 * are between colleagues and name nobody outside. A recipient we only ever
 * wrote to borrows the name they signed with elsewhere in the conversation, if
 * they ever wrote back: a bare address beside the same address with a name is
 * two entries for one person.
 */
export function threadContacts(messages: MessageLike[]): ThreadContact[] {
  const names = new Map<string, string>()
  for (const m of messages) {
    const address = m.direction === 'in' ? (m.fromAddress || m.fromPhone || '').trim() : ''
    const name = m.fromName?.trim()
    if (address && name && !names.has(threadContactKey(address))) names.set(threadContactKey(address), name)
  }

  const seen = new Set<string>()
  const found: ThreadContact[] = []
  const add = (raw: string | null | undefined) => {
    const address = raw?.trim()
    if (!address) return
    const key = threadContactKey(address)
    if (seen.has(key)) return
    seen.add(key)
    found.push({ name: names.get(key) ?? null, address })
  }
  for (const m of [...messages].reverse()) {
    if (m.direction === 'in') add(m.fromAddress || m.fromPhone)
    else if (m.direction === 'out') m.toAddresses.forEach(add)
  }
  return found
}
