import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getInbox } from '@/modules/unified-inbox/lib/db'
import { reofferInbox } from '@/modules/unified-inbox/lib/message-handlers'

// "Offer the last 14 days again": hands an inbox's recent post to the modules
// listening for it, whether or not they have seen it before. For switching a
// listener on after the paperwork has already arrived - see
// lib/message-handlers.ts, and the idempotency every handler promises.
//
// A fortnight of post, each message given a few seconds per listener, does not
// fit in one request. So this does a slice and hands back a cursor, and the
// screen keeps asking until the answer says `done`.
export const maxDuration = 60

/** One request's share. Well inside the function's ceiling, so the slice ends
 *  on the deadline check rather than on the platform's. */
const SLICE_MS = 40_000

const Body = z.object({
  after: z.string().trim().min(1).max(64).nullable().optional(),
})

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const inbox = await getInbox(id)
  if (!inbox) return errorResponse('That inbox no longer exists.', 404)

  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return errorResponse('That request did not look right.')

  const result = await reofferInbox(id, {
    after: parsed.data.after ?? null,
    deadline: Date.now() + SLICE_MS,
  })
  if (result.handlers === 0) {
    return errorResponse('Nothing on this site is listening for post, so there is nobody to offer it to.')
  }
  // `next` null with `done` false is "start again from the beginning" - a
  // first message handed back to be tried again - not the end of the walk.
  return NextResponse.json({ ok: true, offered: result.offered, next: result.next, done: result.done })
}
