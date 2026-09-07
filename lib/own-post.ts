import { prisma } from '@/lib/db/prisma'
import type { Inbox } from './types'

// ---------------------------------------------------------------------------
// A colleague's own post lands on their desk.
//
// An individual inbox is one named person's own address at work (D16). Nobody
// else may open it unless they were deliberately named on it - so a conversation
// sitting in one with nobody's name against it is not shared work waiting to be
// picked up, it is one person's post pretending to be a pile. This hands it to
// them as it arrives.
//
// The rule in one line: INBOUND post, at an INDIVIDUAL address, whose owner can
// still log in, on a conversation NOBODY has yet.
//
// Each of those four does a job:
//
//   inbound     - a copy of the owner's own reply coming back out of Sent is
//                 not somebody getting post.
//   individual  - sales@ is the team's. Handing every enquiry to whoever is
//                 named on a shared address is the opposite of a shared inbox.
//   can log in  - post assigned to a suspended account is post filed out of
//                 sight, which is worse than the unassigned pile it came from.
//                 An owner whose account was deleted reads as no owner at all,
//                 which lib/types.ts already promises.
//   nobody yet  - this fills an empty space and never takes a conversation off
//                 the person who has it. The emptiness is checked in the same
//                 UPDATE that fills it (see assignThreadIfUnassigned), so two
//                 collection ticks racing cannot undo each other.
// ---------------------------------------------------------------------------

/** The half of an inbox this rule has an opinion about, so the pure function
 *  below can be handed a whole `Inbox` and be right. */
export type OwnedInbox = Pick<Inbox, 'id' | 'kind' | 'ownerUserId'>

/**
 * Which address belongs to which colleague, out of every address on the site.
 *
 * Pure, and tested, because the interesting cases are all absences - a shared
 * address, an owner nobody set, an owner who has left - and each of them is a
 * conversation quietly filed under the wrong name if it goes the other way.
 */
export function ownPostOwnerMap(
  inboxes: readonly OwnedInbox[],
  activeUserIds: ReadonlySet<string>,
): Map<string, string> {
  const owners = new Map<string, string>()
  for (const inbox of inboxes) {
    if (inbox.kind !== 'individual') continue
    const owner = inbox.ownerUserId
    if (!owner || !activeUserIds.has(owner)) continue
    owners.set(inbox.id, owner)
  }
  return owners
}

/**
 * The same map, with the staff list read for it.
 *
 * One query per collection run rather than one per message, and none at all on
 * the site that has never made an individual inbox - which is most of them.
 */
export async function ownPostOwners(inboxes: readonly OwnedInbox[]): Promise<Map<string, string>> {
  const wanted = [...new Set(
    inboxes
      .filter((i) => i.kind === 'individual' && i.ownerUserId)
      .map((i) => i.ownerUserId as string),
  )]
  if (wanted.length === 0) return new Map()
  const active = await prisma.user.findMany({
    where: { id: { in: wanted }, suspendedAt: null },
    select: { id: true },
  })
  return ownPostOwnerMap(inboxes, new Set(active.map((u) => u.id)))
}

/**
 * Whose post this message is, or null when it is nobody's in particular.
 *
 * Deliberately says nothing about whether the conversation is already spoken
 * for: that question is asked and answered in one UPDATE at the database, which
 * is the only place two collection ticks arriving at once can be told apart.
 */
export function ownPostAssignee(
  direction: 'in' | 'out',
  inboxId: string | null,
  owners: ReadonlyMap<string, string>,
): string | null {
  if (direction !== 'in' || !inboxId) return null
  return owners.get(inboxId) ?? null
}
