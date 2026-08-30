// DELETE /api/m/unified-inbox/messages/[id] - deletes a provider message via
// its owning module's conversation provider. Only works for messages from
// providers that declare the delete capability (e.g. Twilio voicemails).
import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { prisma } from '@/lib/db/prisma'
import { allConversationProviders } from '@/modules/unified-inbox/lib/provider-registry'

export async function DELETE(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)

  const { id } = await ctx.params

  // Fetch the message to find its provider and provider_message_id
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
    return errorResponse('This message cannot be deleted', 400)
  }

  // Find the provider
  const providers = await allConversationProviders()
  const provider = providers.find((p) => p.moduleName === msg.provider_module)
  if (!provider) return errorResponse('Provider not found', 404)

  // Check if the provider supports deletion
  if (!provider.provider.capabilities.delete || !provider.provider.deleteMessage) {
    return errorResponse('This provider does not support deletion', 400)
  }

  // Call the provider's deleteMessage method
  const deleted = await provider.provider.deleteMessage(msg.provider_message_id)
  if (!deleted) return errorResponse('Failed to delete message', 502)

  // Delete the local message row (cascades to attachments)
  await prisma.$executeRaw`DELETE FROM uin_messages WHERE id = ${id}`

  return NextResponse.json({ ok: true })
}
