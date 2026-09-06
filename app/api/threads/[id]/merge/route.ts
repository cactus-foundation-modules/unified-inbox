import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { canOpenThread } from '@/modules/unified-inbox/lib/access'
import { getThreadDetail, mergeThreads } from '@/modules/unified-inbox/lib/db'
import { mergeSummary } from '@/modules/unified-inbox/lib/thread-merge'
import { ThreadMergeBody } from '@/modules/unified-inbox/lib/validation'

// Folding several conversations into this one.
//
// Behind `unifiedinbox.manage` rather than the everyday reply permission, for
// the same reason merging two people is: this is the operation people regret,
// and although it can be taken back, whoever set the inbox up is the one who
// should be doing it.
//
// EVERY conversation involved is checked, not only the one in the address. A
// merge across two addresses makes the merged conversation readable by everyone
// on either of them (see migrations/031_thread_merges.sql), so somebody who
// cannot open one of the halves must not be able to hand it to a room full of
// people by naming it in the list of what to merge in.

export const maxDuration = 60

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const parsed = ThreadMergeBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('Pick at least one other conversation to merge in.')

  const winner = await getThreadDetail(id)
  if (!winner) return errorResponse('That conversation no longer exists.', 404)
  if (!await canOpenThread(user, winner)) return errorResponse('Forbidden', 403)

  for (const loserId of parsed.data.loserIds) {
    const loser = await getThreadDetail(loserId)
    if (!loser) return errorResponse('One of those conversations is no longer here.', 404)
    // Deliberately the same refusal whether they may not open it or it is not
    // there: an error that distinguishes the two confirms the existence of a
    // conversation in an address somebody has no business knowing about.
    if (!await canOpenThread(user, loser)) return errorResponse('Forbidden', 403)
  }

  const result = await mergeThreads(id, parsed.data.loserIds, user.id)
  if ('error' in result) return errorResponse(result.error)

  return NextResponse.json({
    ok: true,
    threadId: result.winnerId,
    mergeIds: result.mergeIds,
    message: `${mergeSummary(
      { id: winner.id, inboxId: winner.inboxId, subject: winner.subject, status: winner.status, unread: winner.unread, createdAt: winner.createdAt },
      result.merged,
    )} You can put this back from the conversation itself if it was wrong.`,
  })
}
