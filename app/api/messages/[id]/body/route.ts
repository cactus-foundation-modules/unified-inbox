import { NextRequest, NextResponse } from 'next/server'
import { nanoid } from 'nanoid'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { canOpenThread } from '@/modules/unified-inbox/lib/access'
import { getMessageHtml } from '@/modules/unified-inbox/lib/db'
import { buildMessageDocument, messageDocumentCsp } from '@/modules/unified-inbox/lib/message-document'
import { restoreRemoteImages } from '@/modules/unified-inbox/lib/remote-images'

// One message's own HTML, as a whole document, for the frame the thread view
// renders it in (E16). Never inline in the admin: email markup carries its own
// CSS and will otherwise lay out the page around it.
//
// Access is checked here, on this request, for this person - the frame is an
// ordinary request and a message from accounts@ is as unavailable through it as
// it is anywhere else (D16). A conversation that landed in no inbox at all is
// the most private case there is, so only somebody who administers the whole
// thing may open one.
//
// ?images=1 puts the pictures back, pointed at this site's own picture proxy
// rather than at the sender. Nothing fetches anything from a stranger's server
// until somebody asks.

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.view')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const message = await getMessageHtml(id)
  if (!message) return errorResponse('That message no longer exists.', 404)

  if (!await canOpenThread(user, message)) return errorResponse('Forbidden', 403)

  const showImages = request.nextUrl.searchParams.get('images') === '1'
  const collapseQuoted = request.nextUrl.searchParams.get('quoted') !== '1'
  let html = message.html ?? ''
  if (showImages) {
    html = restoreRemoteImages(html, (index) => `/api/m/unified-inbox/messages/${id}/image/${index}`)
  }

  const nonce = nanoid(16)
  const document = buildMessageDocument({ html, nonce, collapseQuoted })

  return new NextResponse(document, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': messageDocumentCsp(nonce),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  })
}
