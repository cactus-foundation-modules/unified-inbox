import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { firstDialler } from '@/lib/dialler/registry'
import { toE164 } from '@/lib/phone'
import { siteDiallingCode } from '@/lib/phone.server'
import { CallBody } from '@/modules/unified-inbox/lib/validation'

// Ringing somebody from the inbox.
//
// The call is placed by whichever module publishes core's `core.dialler` seam.
// This module knows the site can make a call and nothing whatever about how -
// no account, no credentials, no provider name in the code.
//
// TWO-LEG, which is why there is a "call me at" on the form. The site rings the
// person pressing the button first, tells them who is about to be rung, and
// connects the two once they answer. Dialling the customer and hoping somebody
// is holding the phone is not on offer.
//
// The call itself is recorded by the module that placed it and comes back to
// this hub as a phone conversation, so nothing is written down here - the same
// arrangement as a text (see ../sms/route.ts).
//
// BOTH NUMBERS ARE READ AGAIN HERE. The form tidies "020 8138 0512" into
// international form as the box is left, which is a courtesy to whoever is
// typing and not a guarantee about what arrives: this is an HTTP endpoint, and
// a browser is not the only thing that can post to one. Same sum, core's, done
// once more on the way in.

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.reply')) return errorResponse('Forbidden', 403)

  const parsed = CallBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return errorResponse(parsed.error.issues[0]?.message ?? 'That call could not be read.', 400)
  }

  const diallingCode = await siteDiallingCode()
  const to = toE164(parsed.data.to, diallingCode)
  if (!to) return errorResponse('That does not look like a number to ring.', 400)
  const callMeAt = toE164(parsed.data.callMeAt, diallingCode)
  if (!callMeAt) return errorResponse('Your own number does not look right.', 400)

  // Whether it is CONFIGURED is not asked here: that is a round trip to the
  // telephony API, and dial() is about to make the same one and can say what it
  // found. Asking twice would double the wait to learn the same thing.
  const resolved = await firstDialler(user)
  if (!resolved) {
    return errorResponse('This site cannot place calls yet. Whoever looks after it can switch that on.', 400)
  }

  const result = await resolved.dialler.dial({ to, from: parsed.data.from, callMeAt })
  if (!result.ok) return errorResponse(result.reason, 400)

  return NextResponse.json({ ok: true })
}
