// POST /api/m/unified-inbox/messages/[id]/to-phone - moves a text reply off
// the email conversation it was filed on and into the Phone channel.
//
// A customer's text lands on the email conversation that last texted them
// (lib/text-links.ts). Usually that is right. When it is not - "running late,
// be there at ten" is about the delivery, not the quote - this puts it on the
// phone conversation with that number, starting one if there is none, and
// stops filing their texts on the email conversation from here on.
//
// The grant is reply rather than manage, which is where this parts company with
// "Move to its own conversation". That one undoes a threading guess and changes
// what everybody on the address sees; this undoes a filing the person asking
// set up themselves, by sending a text from here.
import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { canOpenThread } from '@/modules/unified-inbox/lib/access'
import { getThreadDetail } from '@/modules/unified-inbox/lib/db'
import {
  moveTextRefusal,
  moveTextToPhone,
  sideTextForMove,
  textLinkFor,
} from '@/modules/unified-inbox/lib/text-links'

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'unifiedinbox.reply'))) return errorResponse('Forbidden', 403)

  const { id } = await ctx.params
  const message = await sideTextForMove(id)
  if (!message) return errorResponse('That message is not here any more.', 404)

  // The same refusal whether they may not open it or it is not there.
  const thread = await getThreadDetail(message.threadId)
  if (!thread || !(await canOpenThread(user, thread))) {
    return errorResponse('That message is not here any more.', 404)
  }

  const link = message.phone ? await textLinkFor(message.phone) : null
  const refusal = moveTextRefusal(message, link)
  if (refusal || !link) return errorResponse(refusal ?? 'That text cannot be moved.', 400)

  const result = await moveTextToPhone(message, link, user.id)
  return NextResponse.json({
    ok: true,
    threadId: result.threadId,
    message: 'Moved to the Phone channel. Their next text goes there too.',
  })
}
