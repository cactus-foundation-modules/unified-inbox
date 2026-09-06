import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { canOpenThread } from '@/modules/unified-inbox/lib/access'
import { getThreadDetail, insertNote, recordEvent } from '@/modules/unified-inbox/lib/db'
import { notifyMentions } from '@/modules/unified-inbox/lib/mentions'
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
// Tagging a colleague puts the conversation on their own list, with its own
// snooze and its own done, and lets them into this one conversation whether or
// not the inbox it sits in was ever shared with them - see lib/mentions.ts,
// which the discussion route shares.

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

  await notifyMentions({ threadId: id, thread, mentions, byUserId: user.id, messageId, note: text })

  return NextResponse.json({ ok: true, messageId })
}
