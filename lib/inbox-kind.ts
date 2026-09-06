import { prisma } from '@/lib/db/prisma'
import { audienceForSave } from './access'
import { setInboxAudience } from './db'
import type { Inbox, InboxKind } from './types'

// ---------------------------------------------------------------------------
// The two kinds of inbox, on the way in.
//
// Everything here is about a save rather than about a read: whether the kind
// and the rest of the form agree with each other, and what has to be written
// alongside the inbox row so the guest list never contradicts it. Reading is
// lib/access.ts, and it is the authority - nothing in this file is what keeps
// an individual inbox private.
// ---------------------------------------------------------------------------

/** The fields of a saved inbox that the kind has an opinion about. */
export type KindShape = {
  kind: InboxKind
  ownerUserId: string | null
  isCatchAll: boolean
}

/**
 * Whether a saved inbox makes sense, in the words the person saving it would
 * use. Null means it does.
 *
 * Pure, and tested, because both routes have to reach the same answer: a create
 * that refuses what an edit accepts is a way in, and this module's guest lists
 * are the thing on the other side of it.
 */
export function kindProblem(inbox: KindShape): string | null {
  if (inbox.kind !== 'individual') return null
  if (!inbox.ownerUserId) {
    return 'Say whose inbox this is, or make it a shared one.'
  }
  if (inbox.isCatchAll) {
    // Unplaceable post is everybody's problem and nobody's in particular, so
    // filing it into one person's private mailbox puts it where the person who
    // has to sort it out cannot see it.
    return 'An inbox that belongs to one person cannot be the catch-all. Point the catch-all at a shared inbox instead.'
  }
  return null
}

/**
 * Whether this is somebody who can actually be given an inbox. Null when they
 * cannot, and the reason when they cannot.
 *
 * A suspended account is refused rather than allowed: naming one as the owner
 * would leave an address only a suspended person may read, which is an address
 * nobody may read, and nothing on the screen would say so.
 */
export async function ownerProblem(userId: string): Promise<string | null> {
  const person = await prisma.user.findUnique({
    where: { id: userId },
    select: { suspendedAt: true },
  })
  if (!person) return 'That person no longer has an account on this site.'
  if (person.suspendedAt) return 'That account is suspended, so it cannot be given an inbox of its own.'
  return null
}

/**
 * Write the guest list an individual inbox implies, and do nothing at all to a
 * shared one.
 *
 * Called straight after the inbox row is saved rather than left to the separate
 * request that saves the guest list: the two arrive as two requests and the
 * second of them can fail, and an inbox marked as one person's whose guest list
 * still names the old team is a thing to explain rather than a thing to have.
 * Reading never consults that list on an individual inbox anyway - this keeps
 * the two tables telling the same story.
 */
export async function settleIndividualAudience(inbox: Inbox): Promise<void> {
  if (inbox.kind !== 'individual') return
  const audience = audienceForSave(inbox, [], [])
  await setInboxAudience(inbox.id, audience.entries, audience.defaultUserIds)
}
