import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { setMentionStatus } from '@/modules/unified-inbox/lib/db'
import { MentionPatchBody } from '@/modules/unified-inbox/lib/validation'

// Working through something a colleague asked you to look at: put it off until
// Thursday, mark it done, open it again.
//
// It is nobody else's to settle, which is what makes this a route of its own
// rather than another branch of the conversation's. The conversation has ONE
// status shared by everybody who can read it; an ask has one per person, so
// three colleagues asked about the same order each work through their own and
// none of them clears it from under the others.
//
// The person is part of the WHERE clause rather than checked beforehand (see
// setMentionStatus): an id is guessable, and settling somebody else's job for
// them is not on offer at any price. Nothing matched means exactly that, said
// out loud - a silent no-op would read as a button that does not work.
//
// No guest-list check here on purpose. Being asked is itself the grant (see
// canOpenThread), and a colleague who was let into one conversation must be
// able to say they have dealt with it. What they cannot do is answer it: that
// is a separate permission everywhere else in this module and stays one.

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.view')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const parsed = MentionPatchBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That change does not look right.', 400)
  const { status, snoozeUntil } = parsed.data

  const until = snoozeUntil ? new Date(snoozeUntil) : null
  if (status === 'snoozed' && (!until || Number.isNaN(until.getTime()))) {
    return errorResponse('Say when it should come back.', 400)
  }

  const changed = await setMentionStatus({ id, userId: user.id, status, until })
  if (!changed) return errorResponse('That is not one of yours to change.', 404)

  return NextResponse.json({ ok: true })
}
