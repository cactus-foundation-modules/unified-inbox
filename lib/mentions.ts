import { prisma } from '@/lib/db/prisma'
import { upsertAlert } from '@/lib/notifications/alerts'
import { canUserOpenThread } from './access'
import { recordEvent } from './db'
import type { ThreadShape } from './access'

// Telling a colleague they were asked about something.
//
// Shared by the two places a note can be written - one stuck to a customer's
// conversation, and one that IS the conversation - so the rule about who may be
// told lives in one place rather than in two routes that would drift.
//
// TWO GUARDS, and both have to hold. Only real, unsuspended colleagues, and only
// ones who could open the conversation anyway: a mention is not a way to tell
// somebody that a conversation they may not read exists.
//
// The notification bell is site-wide rather than per person, so the title names
// who was wanted and nothing else - the subject of a conversation in accounts@
// has no business on a bell that everybody can see - and whoever follows the
// link is checked against the inbox on arrival like anybody else.

export async function notifyMentions(input: {
  threadId: string
  thread: ThreadShape
  /** User ids named in the note. Anything unknown is quietly dropped. */
  mentions: string[]
  /** Who did the mentioning, for the event trail. */
  byUserId: string
}): Promise<void> {
  if (input.mentions.length === 0) return

  const named = await prisma.user.findMany({
    where: { id: { in: input.mentions }, suspendedAt: null },
    select: { id: true, displayName: true, username: true },
  })

  for (const person of named) {
    const readable = await canUserOpenThread(person.id, input.thread)
    if (!readable) continue
    await recordEvent(input.threadId, input.byUserId, 'mentioned', { userId: person.id })
    await upsertAlert({
      type: 'message',
      dedupeKey: `unified-inbox:mention:${input.threadId}:${person.id}`,
      title: `${person.displayName || person.username} was asked about a conversation`,
      link: `/inbox?tab=unified-inbox&id=${encodeURIComponent(input.threadId)}`,
      actionLabel: 'Open the conversation',
    })
  }
}
