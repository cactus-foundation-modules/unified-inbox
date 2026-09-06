import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { canViewInbox } from '@/modules/unified-inbox/lib/access'
import { createDiscussionThread, insertNote, recordEvent } from '@/modules/unified-inbox/lib/db'
import { notifyMentions } from '@/modules/unified-inbox/lib/mentions'
import { noteHtml } from '@/modules/unified-inbox/lib/notes'
import { normaliseSubject } from '@/modules/unified-inbox/lib/threading'
import { DiscussionBody } from '@/modules/unified-inbox/lib/validation'

// Starting a discussion: a conversation between colleagues that no customer
// ever sees.
//
// It is made of the same internal notes the hub has always had, which is the
// point - nothing sends, nothing can be talked into sending, and there is no
// address on it to send to. What it adds is somewhere to put the FIRST one: a
// remark about the Henderson order was previously only possible if the
// Hendersons had written in.
//
// VIEW, NOT REPLY. Writing a note has always taken `unifiedinbox.view` and a
// place on the inbox's guest list, because a note leaves the building through
// no door at all. Starting one is the same act with nothing above it, so it
// asks the same question - and it asks it of every address named, one at a
// time, rather than of the first and hopefully the rest.
//
// ONE DISCUSSION PER ADDRESS NAMED. A conversation is read by whoever may read
// the inbox it sits in (D16); one thread in two inboxes would be one
// conversation with two guest lists, two unread counts and no honest answer
// about who can see it. So naming three addresses starts three discussions,
// exactly as an email to three of the site's own addresses already becomes
// three conversations (migrations/020_internal_threads.sql).

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.view')) return errorResponse('Forbidden', 403)

  const parsed = DiscussionBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return errorResponse(parsed.error.issues[0]?.message ?? 'That discussion could not be read.', 400)
  }
  const { subject, body, mentions = [] } = parsed.data

  // The same address twice is one discussion, not two.
  const inboxIds = [...new Set(parsed.data.inboxIds)]

  // Checked before anything is written, so a request naming one address this
  // person may use and one they may not starts nothing at all. Half a
  // discussion is worse than none: the half that landed cannot be recalled.
  for (const inboxId of inboxIds) {
    if (!await canViewInbox(user, inboxId)) {
      return errorResponse('You do not have permission to use one of those addresses.', 403)
    }
  }

  const html = noteHtml(body)
  const preview = body.replace(/\s+/g, ' ').trim().slice(0, 200)
  const threadIds: string[] = []

  for (const inboxId of inboxIds) {
    const threadId = await createDiscussionThread({
      inboxId,
      subject,
      subjectNormalised: normaliseSubject(subject),
      preview: preview || null,
    })
    const messageId = await insertNote({
      threadId,
      channel: 'discussion',
      bodyHtml: html,
      bodyText: body,
      authorUserId: user.id,
    })
    await recordEvent(threadId, user.id, 'note', { messageId })
    await notifyMentions({
      threadId,
      thread: { id: threadId, inboxId, providerModule: null },
      mentions,
      byUserId: user.id,
      messageId,
      note: body,
    })
    threadIds.push(threadId)
  }

  // The first one is where the browser is sent. On the ordinary single-address
  // discussion that is simply "the one you started".
  return NextResponse.json({ threadId: threadIds[0], threadIds })
}
