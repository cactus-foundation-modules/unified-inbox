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
// NOTHING IS DELETED. Mail from a blocked sender is collected like anything
// else and goes straight into the bin: in the Spam folder, marked done so it is
// out of everybody's way, and left unread so the folder can say how much of it
// there is. It is in the bin for EVERYBODY, which is the one place this module
// files something without asking whose opinion it is - a block is a fact about
// the site rather than a view of one conversation. See migration 044.
//
// It used to be left on the mail server and never collected at all. Tidy, and
// wrong in the one way that mattered: "did they ever actually write?" had no
// answer anywhere on this site, and somebody had to go and log into a mailbox
// to find out. A nuisance is a nuisance either way; a customer blocked in a
// temper is a customer, and the difference only shows up weeks later.
//
// Nothing is written to anybody's mailbox either way. This module has never
// touched a mail server except to file a copy of a reply into Sent, and
// blocking somebody does not change that. Unblocking them does not go back for
// anything - the door was shut, and it is now open again.
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
 * Whether a message being filed goes straight into the bin.
 *
 * Pure, and out here on its own, because it is the piece with a genuine wrong
 * answer in it. Two of the three clauses exist because of a way this could go
 * wrong rather than because of a way it should go right:
 *
 *   Only INBOUND mail. A copy of our own reply, found in the Sent folder of an
 *   account whose owner has been blocked by somebody else, is our own writing
 *   coming home. Binning that would quietly stop a colleague's replies ever
 *   reaching the conversation they belong to.
 *
 *   Only a sender we actually have. Mail with no From address at all is
 *   unusual and not, by that fact, from somebody on the list.
 */
export function shouldJunkSender(input: {
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

/** Every address the site refuses, newest first. For the settings screen and
 *  for the Spam folder's own list, which are the two places one can be taken
 *  off again. Newest first because the block somebody is hunting for is nearly
 *  always the one they have just made, or the one somebody made this week that
 *  a customer is now complaining about. */
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
 *  of this file - and what was collected while the door was shut stays in the
 *  Spam folder until somebody says otherwise, one conversation at a time. */
export async function unblockSender(address: string): Promise<void> {
  const key = normaliseAddress(address)
  if (!key) return
  await prisma.$executeRaw`DELETE FROM "uin_blocked_senders" WHERE "address" = ${key}`
}
