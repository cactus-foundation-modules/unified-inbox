import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { canViewInbox } from '@/modules/unified-inbox/lib/access'
import { getMessageHtml } from '@/modules/unified-inbox/lib/db'
import { fetchRemoteImage, remoteImageUrls } from '@/modules/unified-inbox/lib/remote-images'

// A picture from inside an email, fetched by this site rather than by the
// reader's browser.
//
// The address never comes from the request. The caller asks for picture number
// three of a message it names, and the address is read out of the stored
// message here - so nothing can talk this route into fetching an arbitrary URL
// by asking for one. What it can still do is email us a link and hope somebody
// presses "Show pictures", which is why lib/remote-images.ts refuses anything
// that is not https, resolves inside this network, or comes back as something
// other than a picture.
//
// Same access check as the message itself: whoever may not read the
// conversation may not fetch what is in it either.

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; index: string }> },
) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.view')) return errorResponse('Forbidden', 403)

  const { id, index } = await params
  const message = await getMessageHtml(id)
  if (!message) return errorResponse('That message no longer exists.', 404)

  const allowed = message.inboxId
    ? await canViewInbox(user, message.inboxId)
    : await hasPermission(user, 'unifiedinbox.manage')
  if (!allowed) return errorResponse('Forbidden', 403)

  const urls = remoteImageUrls(message.html)
  const position = Number.parseInt(index, 10)
  const url = Number.isInteger(position) ? urls[position] : undefined
  if (!url) return errorResponse('There is no such picture in that message.', 404)

  const result = await fetchRemoteImage(url)
  if (!result.ok) return errorResponse(result.reason, 502)

  return new NextResponse(new Uint8Array(result.bytes), {
    headers: {
      'Content-Type': result.contentType,
      'Content-Length': String(result.bytes.byteLength),
      // Never inline as anything but an image, and never left lying in a shared
      // cache: it came out of somebody's private correspondence.
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=300',
    },
  })
}
