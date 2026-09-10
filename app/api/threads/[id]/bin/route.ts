// POST /api/m/unified-inbox/threads/[id]/bin - put a conversation in a bin, or
// take it back out again.
//
// WHOSE BIN IT GOES INTO IS WORKED OUT HERE, and never asked for. The body
// carries one boolean and nothing else: a body that could name a user id would
// be a body that could clear a colleague's inbox for them, or fill it.
//
// The answer is usually the person pressing the button, and is the address's
// owner when the conversation sits in a colleague's own inbox - somebody
// covering Sam's post while Sam is away is filling Sam's bin, not their own.
// See binOwnerFor, which is the junk rule under a second name because it is the
// same rule.
//
// NOTHING IS DESTROYED HERE. This route hides a conversation from one person's
// lists and does nothing else at all; pressing the button again in the Bin
// folder brings it straight back. What destroys is next door, in
// app/api/bin/empty, and it only runs when somebody presses "Empty bin" and
// answers the question it puts up. Neither route touches a mail server: the
// message stays exactly where it is in whatever mailbox it was collected from.
import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { canOpenThread } from '@/modules/unified-inbox/lib/access'
import { getInbox, getThreadDetail } from '@/modules/unified-inbox/lib/db'
import { binOwnerFor, markThreadBinned, unmarkThreadBinned } from '@/modules/unified-inbox/lib/bin'
import { ThreadBinBody } from '@/modules/unified-inbox/lib/validation'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)

  // Reading it is the bar, exactly as it is for marking one done or as junk.
  // This changes one person's own view of a conversation they can already open,
  // it puts back with the same press, and stopping somebody tidying their own
  // screen would only mean a bin nobody can fill. Emptying one is a different
  // question with a different answer - see the other route.
  if (!(await hasPermission(user, 'unifiedinbox.view'))) return errorResponse('Forbidden', 403)

  const { id } = await params
  const thread = await getThreadDetail(id)
  if (!thread) return errorResponse('That conversation no longer exists.', 404)
  if (!(await canOpenThread(user, thread))) return errorResponse('Forbidden', 403)

  const parsed = ThreadBinBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That change does not look right.', 400)

  // The conversation's OWN address, not the ones a merge has since added to it -
  // one home is an answer that can be explained. Already established as one this
  // reader may open, by canOpenThread above.
  const inbox = thread.inboxId ? await getInbox(thread.inboxId) : null
  const owner = binOwnerFor({ pressedByUserId: user.id, inbox })

  if (parsed.data.bin) await markThreadBinned(id, owner)
  else await unmarkThreadBinned(id, owner)

  // `owner` goes back so the screen can say whose bin it landed in when that is
  // not the presser's - "Moved to Sam's bin" is a different sentence from
  // "Moved to your bin", and a colleague who thought they were tidying their
  // own deserves to be told which of the two happened.
  return NextResponse.json({ ok: true, bin: parsed.data.bin, ownerUserId: owner })
}
