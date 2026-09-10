import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { isReplySuggestionError } from '@/lib/conversations/reply-suggestion-error'
import { suggestReplies } from '@/lib/conversations/reply-suggestions'
import { canOpenThread } from '@/modules/unified-inbox/lib/access'
import { getThreadDetail } from '@/modules/unified-inbox/lib/db'
import { transcriptForThread } from '@/modules/unified-inbox/lib/reply-transcript'

// "Give me something to start from" for one conversation.
//
// This module holds the conversation and nothing else: it reads its own
// messages, hands them over as plain words and hands back whatever comes out.
// WHICH module writes the drafts - and whether any module on this site can - is
// core's business, resolved from `core.reply-suggestions`. Nothing here names
// one, and a site with none installed gets a 409 saying so in English.
//
// The guard is the same pair the screen itself uses: the right to answer
// anything at all, and then the right to open THIS conversation. A draft about
// a conversation somebody may not read would be a way of reading it.

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.reply')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const thread = await getThreadDetail(id)
  if (!thread) return errorResponse('That conversation no longer exists.', 404)
  if (!await canOpenThread(user, thread)) return errorResponse('Forbidden', 403)

  try {
    const { suggestions } = await suggestReplies({
      messages: await transcriptForThread(thread.id),
      subject: thread.subject,
      authorName: user.displayName ?? null,
    })
    return NextResponse.json({ suggestions }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (cause) {
    if (isReplySuggestionError(cause)) return errorResponse(cause.message, cause.status)
    console.error('[unified-inbox] could not suggest a reply', cause)
    return errorResponse('Could not get any suggestions just now. Try again in a moment.', 502)
  }
}
