import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { prisma } from '@/lib/db/prisma'
import { upsertAlert } from '@/lib/notifications/alerts'
import { canOpenThread, canUserOpenThread } from '@/modules/unified-inbox/lib/access'
import { getThreadDetail, insertNote, recordEvent } from '@/modules/unified-inbox/lib/db'
import { NoteBody } from '@/modules/unified-inbox/lib/validation'
import { noteHtml } from '@/modules/unified-inbox/lib/notes'

// An internal note on a conversation: something colleagues can see and the
// customer never will. It is stored as a message with direction 'note', which
// is why nothing anywhere sends one.
//
// A note deliberately does not bump the conversation up the list or mark it
// unread (see insertNote): us talking among ourselves should not look like the
// customer writing again.
//
// Mentioning a colleague raises one of core's notifications. The notification
// bell is site-wide rather than per person, so the title names who was wanted
// and nothing else - the subject of a conversation in accounts@ has no business
// on a bell that everybody can see, and whoever follows the link is checked
// against the inbox on arrival like anybody else.

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.view')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const thread = await getThreadDetail(id)
  if (!thread) return errorResponse('That conversation no longer exists.', 404)

  if (!await canOpenThread(user, thread)) return errorResponse('Forbidden', 403)

  const parsed = NoteBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That note does not look right.', 400)
  const { text, mentions = [] } = parsed.data

  const messageId = await insertNote({
    threadId: id,
    channel: thread.channel,
    bodyHtml: noteHtml(text),
    bodyText: text,
    authorUserId: user.id,
  })
  await recordEvent(id, user.id, 'note', { messageId })

  if (mentions.length > 0) {
    // Only real, unsuspended colleagues, and only ones who could open the
    // conversation anyway - a mention is not a way to tell somebody that a
    // conversation they may not read exists.
    const named = await prisma.user.findMany({
      where: { id: { in: mentions }, suspendedAt: null },
      select: { id: true, displayName: true, username: true },
    })
    for (const person of named) {
      const readable = await canUserOpenThread(person.id, thread)
      if (!readable) continue
      await recordEvent(id, user.id, 'mentioned', { userId: person.id })
      await upsertAlert({
        type: 'message',
        dedupeKey: `unified-inbox:mention:${id}:${person.id}`,
        title: `${person.displayName || person.username} was asked about a conversation`,
        link: `/inbox?tab=unified-inbox&id=${encodeURIComponent(id)}`,
        actionLabel: 'Open the conversation',
      })
    }
  }

  return NextResponse.json({ ok: true, messageId })
}
