// POST /api/m/unified-inbox/messages/[id]/split - moves one message out of its
// conversation and onto a new one of its own.
//
// The other half of the merge, and it exists for the same reason: threading is
// a heuristic. A dropped References header and two customers who both wrote
// "Re: Quote" is all it takes to glue a stray email onto somebody else's
// conversation, and until this route the only answers were to live with it or
// throw the whole conversation away.
//
// THE GRANT IS `manage`, the same as merging, and for the same reason - this is
// the operation people regret, it changes what everybody on the address sees,
// and whoever set the inbox up is the one who should be doing it.
//
// THE UNDO IS THE MERGE. Nothing here writes a snapshot of its own: the two
// conversations are merged back together, which is a thing this module already
// does and already tests. A bespoke undo would be a second, subtly different
// implementation of moving messages between conversations.
import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { canOpenThread } from '@/modules/unified-inbox/lib/access'
import {
  getThreadDetail,
  messageForAction,
  splitMessageToNewThread,
} from '@/modules/unified-inbox/lib/db'

export async function POST(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'unifiedinbox.manage'))) return errorResponse('Forbidden', 403)

  const { id } = await ctx.params

  const message = await messageForAction(id)
  if (!message) return errorResponse('That message is not here any more.', 404)

  // Deliberately the same refusal whether they may not open it or it is not
  // there, for the reason the merge route gives: telling the two apart confirms
  // the existence of a conversation in an address somebody cannot see.
  const thread = await getThreadDetail(message.threadId)
  if (!thread) return errorResponse('That message is not here any more.', 404)
  if (!(await canOpenThread(user, thread))) return errorResponse('Forbidden', 403)

  const result = await splitMessageToNewThread(message, user.id)
  if ('error' in result) return errorResponse(result.error)

  return NextResponse.json({
    ok: true,
    threadId: result.threadId,
    message: 'Moved to a conversation of its own. Merge the two back together if that was wrong.',
  })
}
