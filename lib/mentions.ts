import { prisma } from '@/lib/db/prisma'
import { upsertAlert } from '@/lib/notifications/alerts'
import { userCanOpenHub } from './access'
import { recordEvent, upsertMention } from './db'
import type { ThreadShape } from './access'

// Asking a colleague to look at something.
//
// Shared by the two places a note can be written - one stuck to a customer's
// conversation, and one that IS the conversation - so the rule about who may be
// asked lives in one place rather than in two routes that would drift.
//
// WHAT A TAG NOW IS. It used to be a bell notice and nothing else, and it was
// quietly dropped altogether for anybody who could not already open the
// conversation. Both of those are gone:
//
//   - It writes a row of its own (migrations/032_mentions.sql) with its own
//     open / snoozed / done, so being asked about something is a piece of work
//     that can be put off until Thursday and finished. The conversation's own
//     status is untouched, because that one is shared and three people asked
//     about one order would otherwise mark it done from under each other.
//
//   - It GRANTS that one conversation to that one person. Only somebody who
//     could already open it can hand it over, it is one conversation rather
//     than the address it sits in, and it grants reading rather than answering
//     (see canOpenThread in lib/access.ts). Sending as accounts@ is still
//     something only accounts@'s own people may do.
//
// ONE GUARD REMAINS, and it is the one that matters: the person must hold the
// hub's own view permission. A tag opens a door into this module; it does not
// hand the module to somebody who was never given it.
//
// The notification bell is site-wide rather than per person, so the title names
// who was wanted and nothing else - the subject of a conversation in accounts@
// has no business on a bell that everybody can see - and whoever follows the
// link is checked against the conversation on arrival like anybody else.

/** How much of a note is worth keeping beside the ask. Enough for the list of
 *  what somebody has been asked about to read without opening every one, and
 *  short enough that the row stays one line. */
const NOTE_SNIPPET = 300

/**
 * Which of the named ids are worth going to the database about.
 *
 * Pure, and the interesting part is what it drops. Duplicates, because the
 * picker and a hand-written request can both produce them and the table holds
 * one row per person either way. And whoever wrote the note: tagging yourself
 * puts a job on your own list that you are, by definition, already doing.
 */
export function whoToTell(mentions: string[], byUserId: string): string[] {
  const out: string[] = []
  for (const raw of mentions) {
    const id = raw.trim()
    if (!id || id === byUserId || out.includes(id)) continue
    out.push(id)
  }
  return out
}

export async function notifyMentions(input: {
  threadId: string
  thread: ThreadShape
  /** User ids named in the note. Anything unknown is quietly dropped. */
  mentions: string[]
  /** Who did the asking, for the event trail and for the row itself. */
  byUserId: string
  /** The note the ask was written on, when there is one. A discussion's opening
   *  message is one; nothing else is. */
  messageId?: string | null
  /** What the note said, kept beside the ask so the list reads. */
  note?: string | null
}): Promise<void> {
  const wanted = whoToTell(input.mentions, input.byUserId)
  if (wanted.length === 0) return

  const named = await prisma.user.findMany({
    where: { id: { in: wanted }, suspendedAt: null },
    select: { id: true, displayName: true, username: true },
  })

  const snippet = (input.note ?? '').trim().slice(0, NOTE_SNIPPET) || null

  for (const person of named) {
    if (!await userCanOpenHub(person.id)) continue
    await upsertMention({
      threadId: input.threadId,
      userId: person.id,
      byUserId: input.byUserId,
      messageId: input.messageId ?? null,
      note: snippet,
    })
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
