// POST /api/m/unified-inbox/messages/[id]/remove - takes one message out of a
// conversation, here, for good.
//
// ---------------------------------------------------------------------------
// NOT THE SAME ROUTE AS ../route.ts, AND NOT THE SAME ACT. That one asks the
// channel that owns a message to delete it at the far end as well - a voicemail
// leaving the phone company's records - and only a channel that says it can do
// that offers it at all. This one destroys the copy THIS SITE holds and touches
// nothing outside it: the email is still in whoever's mailbox it was collected
// from, and a chat is still in the module that owns the chat.
//
// THE GRANT IS `manage`, which is stricter than the grant to read the
// conversation, and the line is the one emptying a bin draws. Anybody who can
// read a conversation can put it in their bin, because that hides it from their
// own screen and puts back with the same press. This goes for everybody who can
// see the address, and nothing brings it back.
//
// BYTES BEFORE ROWS. Any attachment stored under this module's own key prefix
// goes out of storage before the row does, exactly as retention and the bin do
// it, so an interrupted delete leaves an orphaned object the storage check can
// offer up rather than a row pointing at bytes that have gone. A failure there
// is carried rather than fatal for the same reason: a message that will not
// delete because storage was briefly unreachable is a button somebody presses
// over and over.
//
// AND IT LEAVES A GRAVESTONE, which is the whole difficulty of this route and
// the reason it is not four lines long. See migration 054: the collection's
// dedupe is a lookup in the very table this deletes from, so without a line
// drawn against the message's identity it is filed straight back the next time
// it is seen anywhere the ledger has not already walked.
// ---------------------------------------------------------------------------
import { NextRequest, NextResponse } from 'next/server'
import type { MediaProviderType } from '@prisma/client'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { deleteMedia } from '@/lib/media/upload'
import { errorResponse } from '@/lib/utils'
import { canOpenThread } from '@/modules/unified-inbox/lib/access'
import {
  deleteMessageHere,
  getThreadDetail,
  messageForAction,
  storedObjectsForMessage,
} from '@/modules/unified-inbox/lib/db'

export async function POST(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'unifiedinbox.manage'))) return errorResponse('Forbidden', 403)

  const { id } = await ctx.params

  const message = await messageForAction(id)
  if (!message) return errorResponse('That message is not here any more.', 404)

  // Being allowed to manage addresses is not being allowed to read every
  // address. Deliberately the same refusal whether they may not open it or it
  // is not there: an error that told the two apart would confirm the existence
  // of a conversation in an address somebody has no business knowing about.
  const thread = await getThreadDetail(message.threadId)
  if (!thread) return errorResponse('That message is not here any more.', 404)
  if (!(await canOpenThread(user, thread))) return errorResponse('Forbidden', 403)

  let storedObjectFailures = 0
  for (const object of await storedObjectsForMessage(message.id)) {
    try {
      await deleteMedia(object.mediaProvider as MediaProviderType, object.mediaKey)
    } catch (err) {
      storedObjectFailures += 1
      console.warn('[unified-inbox] deleting a message could not remove a stored attachment:', err)
    }
  }

  await deleteMessageHere(message, user.id)

  return NextResponse.json({ ok: true, threadId: message.threadId, storedObjectFailures })
}
