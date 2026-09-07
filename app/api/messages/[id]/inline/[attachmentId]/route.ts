import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { canOpenThread } from '@/modules/unified-inbox/lib/access'
import { getAttachment, getMessageAccess } from '@/modules/unified-inbox/lib/db'
import { loadAttachmentBytes } from '@/modules/unified-inbox/lib/attachments'
import { isDisplayableImageType } from '@/modules/unified-inbox/lib/inline-images'

// A picture that arrived inside the message, served back to the frame reading it.
//
// The signature logo in an Outlook email, or a screenshot pasted into the
// middle of a sentence, is an ordinary attachment that the markup points at by
// its Content-ID. Nothing is fetched from anywhere to show one - the bytes are
// already ours - so unlike a remote picture this is not held behind "Show
// pictures": there is no sender left to learn that the message was opened.
//
// Same access check as the message itself, on this request, for this person: a
// picture out of a conversation in accounts@ is as unavailable as the
// conversation. The attachment is checked to belong to the message that was
// named, so holding one id does not open somebody else's post.
//
// Served inline, which the download route deliberately never does, and that is
// the whole reason this is a route of its own rather than a flag on that one.
// Inline is only safe because of the two lines that follow it: a strict list of
// picture types - no SVG, which is markup with script in it - and nosniff, so a
// browser cannot decide for itself that this was really HTML all along.

export const maxDuration = 60

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.view')) return errorResponse('Forbidden', 403)

  const { id, attachmentId } = await params
  const message = await getMessageAccess(id)
  if (!message) return errorResponse('That message no longer exists.', 404)

  if (!await canOpenThread(user, { ...message, id: message.threadId })) {
    return errorResponse('Forbidden', 403)
  }

  const attachment = await getAttachment(attachmentId)
  if (!attachment || attachment.messageId !== id) {
    return errorResponse('There is no such picture in that message.', 404)
  }

  const result = await loadAttachmentBytes(attachmentId)
  if (!result.ok) return errorResponse(result.reason, result.status)
  if (!isDisplayableImageType(result.contentType)) {
    return errorResponse('That part of the message is not a picture.', 415)
  }

  return new NextResponse(new Uint8Array(result.buffer), {
    headers: {
      'Content-Type': result.contentType,
      'Content-Length': String(result.buffer.length),
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      // Somebody's private correspondence: never left in a shared cache, and
      // held only long enough that scrolling back up a thread is not a refetch.
      'Cache-Control': 'private, max-age=300',
    },
  })
}
