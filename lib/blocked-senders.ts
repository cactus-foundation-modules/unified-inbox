import { prisma } from '@/lib/db/prisma'
import { normaliseAddress } from './addresses'

// ---------------------------------------------------------------------------
// The site's front door.
//
// One list for the whole site, deliberately. A block that only covered the
// address you happened to be standing in when you pressed the button is not a
// block: the sender simply writes to hello@ instead, and the next person finds
// them in a different list. So somebody blocked is blocked everywhere - every
// shared address, every colleague's own address, and the one nobody has opened
// since March.
//
// NOTHING IS DELETED, and nothing is even moved. Mail from a blocked sender is
// not collected: it stays on the mail server, in whatever the account's owner
// calls their own junk folder, exactly where it landed. This module has never
// written to anybody's mailbox except to file a copy of a reply into Sent, and
// blocking somebody does not change that. Unblocking them does not go back for
// what was missed either - the door was shut, and it is now open again.
//
// WHAT IS ALREADY HERE STAYS HERE. Blocking a sender says nothing about the
// conversations they have already had with this site: often the whole reason
// somebody wants a caller stopped is the history they need to keep. Marking
// those as junk is the other button, and it is a separate press for a reason.
// ---------------------------------------------------------------------------

export type BlockedSender = {
  id: string
  /** Normalised: lower case, trimmed. What arrives is normalised the same way
   *  before it is compared, so a block cannot be walked around with capitals. */
  address: string
  /** Who shut the door, or null where their account has since gone. */
  blockedByUserId: string | null
  createdAt: Date
}

/**
 * Whether a message being filed should be turned away at the door.
 *
 * Pure, and out here on its own, because it is the piece with a genuine wrong
 * answer in it. Two of the three clauses exist because of a way this could go
 * wrong rather than because of a way it should go right:
 *
 *   Only INBOUND mail. A copy of our own reply, found in the Sent folder of an
 *   account whose owner has been blocked by somebody else, is our own writing
 *   coming home. Turning that away would quietly stop a colleague's replies
 *   ever reaching the conversation they belong to.
 *
 *   Only a sender we actually have. Mail with no From address at all is
 *   unusual and not, by that fact, from somebody on the list.
 */
export function shouldRefuseSender(input: {
  direction: 'in' | 'out'
  /** Already normalised - the caller has one, and normalising twice here would
   *  hide a caller that had not. */
  fromAddress: string | null
  blocked: ReadonlySet<string>
}): boolean {
  if (input.direction !== 'in') return false
  if (!input.fromAddress) return false
  return input.blocked.has(input.fromAddress)
}

/** Every address the site refuses, newest first. For the settings screen, which
 *  is the only place that can take one off again. */
export async function listBlockedSenders(): Promise<BlockedSender[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "id", "address", "blocked_by_user_id", "created_at"
      FROM "uin_blocked_senders"
     ORDER BY "created_at" DESC
  `
  return rows.map((r) => ({
    id: r.id as string,
    address: r.address as string,
    blockedByUserId: (r.blocked_by_user_id as string | null) ?? null,
    createdAt: r.created_at as Date,
  }))
}

/**
 * The whole list as a set, for the collecting pass.
 *
 * Read once per run and asked in memory afterwards: a site that has blocked
 * forty spammers is forty strings, and a query per message would be a query per
 * message.
 */
export async function blockedSenderSet(): Promise<Set<string>> {
  const rows = await prisma.$queryRaw<{ address: string }[]>`
    SELECT "address" FROM "uin_blocked_senders"
  `
  return new Set(rows.map((r) => r.address))
}

/** Whether one address is on the list. */
export async function isSenderBlocked(address: string): Promise<boolean> {
  const key = normaliseAddress(address)
  if (!key) return false
  const rows = await prisma.$queryRaw<{ one: number }[]>`
    SELECT 1 AS "one" FROM "uin_blocked_senders" WHERE "address" = ${key} LIMIT 1
  `
  return rows.length > 0
}

/** Shut the door on somebody. Blocking an address already blocked leaves the
 *  original row - including who blocked them and when, which is the half of it
 *  worth keeping. */
export async function blockSender(address: string, userId: string | null): Promise<void> {
  const key = normaliseAddress(address)
  if (!key) throw new Error('There is no address to block on this conversation.')
  await prisma.$executeRaw`
    INSERT INTO "uin_blocked_senders" ("address", "blocked_by_user_id")
    VALUES (${key}, ${userId})
    ON CONFLICT ("address") DO NOTHING
  `
}

/** Open it again. Nothing is fetched retrospectively - see the note at the top
 *  of this file. */
export async function unblockSender(address: string): Promise<void> {
  const key = normaliseAddress(address)
  if (!key) return
  await prisma.$executeRaw`DELETE FROM "uin_blocked_senders" WHERE "address" = ${key}`
}
