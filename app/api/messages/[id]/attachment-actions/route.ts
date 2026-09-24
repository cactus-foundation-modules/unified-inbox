// GET  /api/m/unified-inbox/messages/[id]/attachment-actions - where each file
//      on a channel's message stands, and what can be done to it there.
// POST /api/m/unified-inbox/messages/[id]/attachment-actions - does one of them.
//      Body: { url, actionId }, both exactly as the GET handed them out.
//
// For a message a channel owns, whose files that channel still looks after - a
// call recording that can be taken off the phone company's servers, the copy of
// it kept here afterwards. Only channels that declare the attachmentActions
// capability are asked; everything else answers an empty list, which a screen
// reads as "nothing to offer".
//
// The same two gates as deleting a channel's message (../route.ts): being in the
// inbox at all, and being allowed on THIS channel. Plus being allowed to open
// the conversation, as the remove route checks, because an action on a file is
// an action on somebody's correspondence.
//
// Nothing here is stored. The channel is asked fresh each time the message is
// opened, and the attachment row we hold keeps the url it was filed with - which
// goes on working for as long as the channel says the file is available.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie, type SessionUser } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import type { ConversationProvider } from '@/lib/conversations/types'
import {
  allConversationProviders,
  providerPermissionFor,
} from '@/modules/unified-inbox/lib/provider-registry'
import { canOpenThread } from '@/modules/unified-inbox/lib/access'
import { getThreadDetail, messageForAction } from '@/modules/unified-inbox/lib/db'

type Resolved =
  | { ok: true; provider: ConversationProvider; providerMessageId: string }
  | { ok: false; response: Response }

async function resolve(user: SessionUser, id: string): Promise<Resolved> {
  const fail = (message: string, status: number) => ({ ok: false as const, response: errorResponse(message, status) })

  if (!(await hasPermission(user, 'unifiedinbox.view'))) return fail('Forbidden', 403)

  const message = await messageForAction(id)
  if (!message) return fail('That message is not here any more.', 404)
  if (message.source !== 'provider' || !message.providerModule || !message.providerMessageId) {
    return fail('Nothing can be done to the files on this message here.', 400)
  }

  const thread = await getThreadDetail(message.threadId)
  if (!thread) return fail('That message is not here any more.', 404)
  if (!(await canOpenThread(user, thread))) return fail('Forbidden', 403)

  const { known, permission } = await providerPermissionFor(message.providerModule)
  if (!known) return fail('The part of the site that handles this channel is no longer installed.', 404)
  if (permission && !(await hasPermission(user, permission))) return fail('Forbidden', 403)

  const found = (await allConversationProviders()).find((p) => p.id === message.providerModule)
  if (!found) return fail('That channel is not available at the moment.', 404)

  return { ok: true, provider: found.provider, providerMessageId: message.providerMessageId }
}

export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)

  const { id } = await ctx.params
  const resolved = await resolve(user, id)
  if (!resolved.ok) return resolved.response

  const { provider, providerMessageId } = resolved
  if (!provider.capabilities.attachmentActions || !provider.attachmentStates) {
    return NextResponse.json({ states: [] })
  }

  try {
    return NextResponse.json({ states: await provider.attachmentStates(providerMessageId) })
  } catch (err) {
    console.error('[unified-inbox] channel could not say where its files stand', id, err)
    return errorResponse('The channel could not be asked about this message just now.', 502)
  }
}

const ActionBody = z.object({
  url: z.string().min(1).max(2000),
  actionId: z.string().min(1).max(100),
})

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)

  const parsed = ActionBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That request did not make sense.', 400)

  const { id } = await ctx.params
  const resolved = await resolve(user, id)
  if (!resolved.ok) return resolved.response

  const { provider, providerMessageId } = resolved
  if (!provider.capabilities.attachmentActions || !provider.attachmentAction) {
    return errorResponse('Nothing can be done to the files on this message here.', 400)
  }

  try {
    await provider.attachmentAction(providerMessageId, parsed.data.url, parsed.data.actionId)
  } catch (err) {
    console.error('[unified-inbox] channel could not act on a file', id, parsed.data.actionId, err)
    // The channel words its own refusals for a person to read; anything that
    // is not one of those is a stack trace, which is not.
    const message = err instanceof Error && err.message && err.message.length < 300 && !/\bat\s+\S+\s\(/.test(err.message)
      ? err.message
      : 'That could not be done just now. Try again in a moment.'
    return errorResponse(message, 502)
  }

  const states = provider.attachmentStates ? await provider.attachmentStates(providerMessageId).catch(() => []) : []
  return NextResponse.json({ ok: true, states })
}
