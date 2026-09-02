// DELETE /api/m/unified-inbox/messages/[id] - gets rid of one message a channel
// owns, at the far end as well as here, via that channel's conversation
// provider. Only providers that declare the delete capability offer it at all;
// today that means a Twilio voicemail.
import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { prisma } from '@/lib/db/prisma'
import {
  allConversationProviders,
  providerPermissionFor,
} from '@/modules/unified-inbox/lib/provider-registry'
import { recountProviderThread } from '@/modules/unified-inbox/lib/db'

export async function DELETE(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)

  // Being signed in was the whole of the check here until 0.1.27, which meant
  // anybody with an account could delete out of the call log. Two permissions
  // are needed and they answer different questions: whether this person may be
  // in the inbox at all, and whether they may act on THIS channel - the same
  // rule that decides whether they can see it, because a channel suppressed on
  // its own screen must not be reachable through the hub.
  if (!(await hasPermission(user, 'unifiedinbox.view'))) return errorResponse('Forbidden', 403)

  const { id } = await ctx.params

  const message = await prisma.$queryRaw<Array<{
    id: string
    source: string
    provider_module: string | null
    provider_message_id: string | null
    thread_id: string
  }>>`
    SELECT id, source, provider_module, provider_message_id, thread_id
    FROM uin_messages
    WHERE id = ${id}
  `

  if (message.length === 0) return errorResponse('Message not found', 404)
  const msg = message[0]!

  if (msg.source !== 'provider' || !msg.provider_module || !msg.provider_message_id) {
    return errorResponse('That kind of message cannot be deleted here.', 400)
  }

  const { known, permission } = await providerPermissionFor(msg.provider_module)
  if (!known) {
    return errorResponse(
      'The part of the site that handles this channel is no longer installed, so this cannot be deleted here.',
      404,
    )
  }
  if (permission && !(await hasPermission(user, permission))) return errorResponse('Forbidden', 403)

  const providers = await allConversationProviders()
  const provider = providers.find((p) => p.moduleName === msg.provider_module)
  if (!provider) return errorResponse('That channel is not available at the moment.', 404)

  if (!provider.provider.capabilities.delete || !provider.provider.deleteMessage) {
    return errorResponse('That kind of message cannot be deleted here.', 400)
  }

  // Three answers, and they are deliberately not the same. False is "this
  // provider will not delete this message" - a refusal worth putting into words.
  // A throw is "it tried and could not", which is worth trying again. True
  // includes a message the far end no longer holds, so somebody is never left
  // with a row they cannot clear.
  let deleted: boolean
  try {
    deleted = await provider.provider.deleteMessage(msg.provider_message_id)
  } catch (err) {
    console.error('[unified-inbox] provider could not delete message', id, err)
    return errorResponse('That could not be deleted just now. Try again in a moment.', 502)
  }
  if (!deleted) return errorResponse('That kind of message cannot be deleted here.', 400)

  await prisma.$executeRaw`DELETE FROM uin_messages WHERE id = ${id}`

  // The count under the subject is written on the thread row, not worked out
  // when it is read, so without this the conversation goes on claiming a
  // message that is no longer in it. The first version of this route did not.
  await recountProviderThread(msg.thread_id)

  return NextResponse.json({ ok: true })
}
