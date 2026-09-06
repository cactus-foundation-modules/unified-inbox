import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { prisma } from '@/lib/db/prisma'
import { errorResponse } from '@/lib/utils'
import { fetchAvatar } from '@/modules/unified-inbox/lib/avatars'
import { getPerson, getSettings } from '@/modules/unified-inbox/lib/db'

// Somebody's own picture, if they have published one at Gravatar or Libravatar.
//
// Addressed by WHO rather than by what their address hashes to, which is the
// whole point of the route: the browser asks for /avatar/person/<id>, the
// server is the only thing that ever knows the address, and Gravatar and
// Libravatar only ever hear from us. So no email and no hash of one appears in
// any page's markup, no third party learns the IP of whoever is reading their
// mail this morning, and nothing has to be added to the site's image policy
// because every picture is served from this origin. Core does the same for
// member avatars in app/api/members/avatar-proxy - same shape, same reasons.
//
// A miss is by far the common case, so it is cached too, briefly: without that,
// a list of twenty-five conversations from people who have never heard of
// Gravatar is twenty-five outbound lookups on every page load for the rest of
// the site's life.
//
// One size, always 128. It comes down to a circle about thirty pixels across
// and looks right on a retina screen at twice that, and one size means one
// cached picture per person rather than one per place it is drawn.
const SIZE = 128

// Three services at four seconds each is the worst case for one picture, and
// only when every one of them is being slow at once.
export const maxDuration = 30

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ kind: string; id: string }> },
) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.view')) return errorResponse('Forbidden', 403)

  const { kind, id } = await params

  // Re-read here rather than trusting the page that drew the URL, so switching
  // it off in Settings takes effect for a tab somebody left open yesterday too.
  const settings = await getSettings()
  if (!settings.showAvatars) return miss()

  let email: string | null = null
  if (kind === 'person') {
    email = (await getPerson(id))?.primaryEmail ?? null
  } else if (kind === 'user') {
    // A colleague. Suspended staff still appear against messages they sent
    // months ago, so they are looked up the same as anybody else.
    email = (await prisma.user.findUnique({ where: { id }, select: { email: true } }))?.email ?? null
  } else {
    return errorResponse('Not found', 404)
  }
  if (!email) return miss()

  const hit = await fetchAvatar(email, SIZE)
  if (!hit) return miss()

  return new NextResponse(new Uint8Array(hit.body), {
    headers: {
      'Content-Type': hit.contentType,
      // Private, not public: the address of this route says which person id
      // exists, and that is not something to leave sitting in a shared cache.
      // It costs one request per person per browser per day.
      'Cache-Control': 'private, max-age=86400',
      // These are a stranger's bytes. They claimed to be an image and they are
      // served as one; a browser does not get to decide otherwise.
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  })
}

/** Nobody has one. Said as a 404 so the page falls back to initials, and cached
 *  for an hour so a list of people who have never published a picture is not
 *  re-asked on every load - short enough that somebody who signs up at Gravatar
 *  this morning turns up by lunchtime. */
function miss() {
  return new NextResponse(null, {
    status: 404,
    headers: { 'Cache-Control': 'private, max-age=3600' },
  })
}
