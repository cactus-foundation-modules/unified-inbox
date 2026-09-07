// POST /api/m/unified-inbox/threads/[id]/spam - put a conversation in this
// reader's own spam folder, or take it back out again.
//
// WHOSE BIN IT GOES INTO IS WORKED OUT HERE, and never asked for. The body
// carries one boolean and nothing else: a body that could name a user id would
// be a body that could clear a colleague's inbox for them, or fill it.
//
// The answer is usually the person pressing the button, and is the address's
// owner when the conversation sits in a colleague's own inbox - somebody
// covering Sam's post while Sam is away is clearing Sam's bin, not filling
// their own with a fortnight of somebody else's rubbish. See spamOwnerFor.
//
// Nothing is deleted and nothing is moved. Blocking the sender is a different
// act with a different consequence and lives in its own route next door - see
// app/api/blocked-senders.
import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { canOpenThread } from '@/modules/unified-inbox/lib/access'
import { getInbox, getThreadDetail, setThreadBlocked } from '@/modules/unified-inbox/lib/db'
import { markThreadSpam, spamOwnerFor, unmarkThreadSpam } from '@/modules/unified-inbox/lib/spam'
import { ThreadSpamBody } from '@/modules/unified-inbox/lib/validation'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)

  // Reading it is the bar, exactly as it is for marking one done. This changes
  // one person's own view of a conversation they can already open, and stopping
  // somebody tidying their own screen would only mean a spam folder nobody can
  // fill.
  if (!(await hasPermission(user, 'unifiedinbox.view'))) return errorResponse('Forbidden', 403)

  const { id } = await params
  const thread = await getThreadDetail(id)
  if (!thread) return errorResponse('That conversation no longer exists.', 404)
  if (!(await canOpenThread(user, thread))) return errorResponse('Forbidden', 403)

  const parsed = ThreadSpamBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That change does not look right.', 400)

  // The conversation's OWN address, not the ones a merge has since added to it -
  // one home is an answer that can be explained. Already established as one this
  // reader may open, by canOpenThread above.
  const inbox = thread.inboxId ? await getInbox(thread.inboxId) : null
  const owner = spamOwnerFor({ pressedByUserId: user.id, inbox })

  if (parsed.data.spam) await markThreadSpam(id, owner)
  else {
    await unmarkThreadSpam(id, owner)
    // And the site's own stamp with it, where the conversation is one the
    // collecting pass put in the bin because its sender is blocked. Nobody
    // pressed anything to get it in there, so nothing but this would ever take
    // it out - a conversation that cannot be rescued is the one failure a spam
    // folder must not have, and "Not junk" has to mean it on this screen too.
    //
    // Only the conversation. The sender stays blocked: letting one through is
    // not the same decision as opening the front door, and that one is a
    // different button on a different screen.
    //
    // Which is also why `view` is still the right bar for this, even though it
    // is a site-wide row being cleared. The line this module draws is about
    // what happens FROM NOW ON: turning a sender away, or letting them back in,
    // changes what everybody receives for ever and takes `reply`. Rescuing one
    // conversation the reader can already open changes one conversation, and
    // the door it came through is exactly where it was.
    await setThreadBlocked(id, false)
  }

  // `owner` goes back so the screen can say whose bin it landed in when that is
  // not the presser's - "Moved to Sam's spam" is a different sentence from
  // "Moved to your spam", and a colleague who thought they were tidying their
  // own folder deserves to be told which of the two happened.
  return NextResponse.json({ ok: true, spam: parsed.data.spam, ownerUserId: owner })
}
