import { NextRequest, NextResponse } from 'next/server'
import { nanoid } from 'nanoid'
import { getSessionFromCookie } from '@/lib/auth/session'
import { getSiteUrlOrNull } from '@/lib/config/env'
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

  if (!await canOpenThread(user, { ...message, id: message.threadId })) {
    return errorResponse('Forbidden', 403)
  }

  const showImages = request.nextUrl.searchParams.get('images') === '1'
  const collapseQuoted = request.nextUrl.searchParams.get('quoted') !== '1'
  let html = message.html ?? ''
  if (showImages) {
    html = restoreRemoteImages(html, (index) => `/api/m/unified-inbox/messages/${id}/image/${index}`)
  }

  const nonce = nanoid(16)
  const document = buildMessageDocument({ html, nonce, collapseQuoted })

  // Where the pictures are allowed to come from, written out in full. The frame
  // has no origin of its own - it is sandboxed without allow-same-origin, which
  // is what keeps a stranger's email away from this site - so `'self'` in its
  // policy matches nothing at all and used to block the proxy's own pictures
  // silently. Both the address this request arrived on and the one the site is
  // configured with, because a site reached on more than one name would
  // otherwise work on whichever of them the setting happens to say.
  const origins = [request.nextUrl.origin, originOf(getSiteUrlOrNull())]

  return new NextResponse(document, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': messageDocumentCsp(nonce, origins),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  })
}

/** The scheme and host of a configured address, or null when there is nothing
 *  usable there. A CSP source is an origin, so a site URL carrying a path would
 *  otherwise be written into the policy as something no browser matches. */
function originOf(url: string | null): string {
  if (!url) return ''
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}
