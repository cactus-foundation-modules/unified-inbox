import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { canViewInbox } from '@/modules/unified-inbox/lib/access'
import { getAttachment } from '@/modules/unified-inbox/lib/db'
import { loadAttachmentBytes } from '@/modules/unified-inbox/lib/attachments'

// The only way to get at an email attachment.
//
// These files are stored under this module's own key prefix with no media
// library row, so they cannot be browsed, picked or linked to - and they are
// never served from a public storage url. Every request comes through here and
// is checked against the inbox the message landed in, on that request, for that
// person. A supplier invoice from accounts@ is as unavailable to the shop
// assistant as the conversation it was attached to.
//
// A message that landed in no inbox at all (nothing matched and no catch-all
// was set) is treated as the most private case there is: only somebody who can
// administer the whole thing may open it.
export const maxDuration = 60

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.view')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const attachment = await getAttachment(id)
  if (!attachment) return errorResponse('That attachment no longer exists.', 404)

  const allowed = attachment.inboxId
    ? await canViewInbox(user, attachment.inboxId)
    : await hasPermission(user, 'unifiedinbox.manage')
  if (!allowed) return errorResponse('Forbidden', 403)

  const result = await loadAttachmentBytes(id)
  if (!result.ok) return errorResponse(result.reason, result.status)

  return new NextResponse(new Uint8Array(result.buffer), {
    headers: {
      'Content-Type': result.contentType,
      'Content-Length': String(result.buffer.length),
      // Attachment, never inline: arbitrary markup or SVG from a stranger has
      // no business rendering on the admin's own origin.
      'Content-Disposition': `attachment; filename="${result.filename.replace(/["\\]/g, '')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
