import { prisma } from '@/lib/db/prisma'
import type { ReplySuggestionMessage } from '@/lib/conversations/types'
import { htmlToText, readableHtml } from '@/modules/unified-inbox/lib/html'

// One conversation, as plain words, for something that has to READ it rather
// than draw it.
//
// A query of its own rather than listThreadMessages, and for one reason: the
// screen never receives a message's markup - it is fetched into a sandboxed
// frame one message at a time - so the rows the page is built from carry
// `hasHtml` and no HTML at all. Anything reading the conversation back needs
// the words that are IN that markup, and asking for them one message at a time
// would be a round trip per message.
//
// Newest end first out of the database, oldest first on the way back, because a
// conversation with two hundred messages on it should not have all two hundred
// fetched to keep the last dozen.

/** Most messages fetched, however long the conversation is. Core trims the
 *  transcript again by length; this is the cheaper cut, made in the database. */
const MAX_MESSAGES = 40

type Row = {
  direction: string
  from_name: string | null
  from_address: string | null
  body_text: string | null
  body_html: string | null
  sent_at: Date
}

function role(direction: string): ReplySuggestionMessage['role'] {
  if (direction === 'out') return 'us'
  if (direction === 'note') return 'note'
  return 'them'
}

/** The words of one message: what it was sent as, or what its markup says. */
function words(row: Row): string {
  const text = row.body_text?.trim()
  if (text) return text
  const html = readableHtml(row.body_html)
  return html ? htmlToText(html).trim() : ''
}

export async function transcriptForThread(threadId: string): Promise<ReplySuggestionMessage[]> {
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT "direction", "from_name", "from_address", "body_text", "body_html", "sent_at"
      FROM "uin_messages"
     WHERE "thread_id" = ${threadId}
     ORDER BY "sent_at" DESC, "created_at" DESC
     LIMIT ${MAX_MESSAGES}
  `

  return rows
    .reverse()
    .map((row) => ({
      role: role(row.direction),
      authorName: row.from_name?.trim() || row.from_address?.trim() || null,
      sentAt: row.sent_at,
      text: words(row),
    }))
    .filter((message) => message.text.length > 0)
}
