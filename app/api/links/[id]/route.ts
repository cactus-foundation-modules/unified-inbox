import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { canViewInbox } from '@/modules/unified-inbox/lib/access'
import { deleteLink, getLink, getThreadDetail, recordEvent } from '@/modules/unified-inbox/lib/db'

// Removing a link, which is the half of automatic linking that makes the other
// half acceptable. Every automatic link says it was automatic and comes off in
// one click; a guess nobody can undo is not a guess anybody should be making on
// somebody else's behalf.

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.reply')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const link = await getLink(id)
  if (!link) return NextResponse.json({ ok: true })

  // A link hangs off a conversation, and a conversation lives in an inbox with
  // its own guest list. Somebody who cannot open it must not be able to change
  // what is attached to it either.
  if (link.threadId) {
    const thread = await getThreadDetail(link.threadId)
    const allowed = thread
      ? thread.inboxId
        ? await canViewInbox(user, thread.inboxId)
        : await hasPermission(user, 'unifiedinbox.manage')
      : false
    if (!allowed) return errorResponse('Forbidden', 403)
    await recordEvent(link.threadId, user.id, 'unlinked', {
      moduleName: link.moduleName,
      recordType: link.recordType,
      label: link.label,
    })
  }

  await deleteLink(id)
  return NextResponse.json({ ok: true })
}
