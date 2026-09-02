// POST /api/m/unified-inbox/threads/[id]/block - refuse the other party on a
// conversation from here on, or let them through again. The channel that owns
// them does the actual refusing; this only decides who may ask for it.
//
// Blocking never deletes anything. What already happened stays where it is -
// often the whole reason somebody wants the caller stopped is the history they
// need to keep.
import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getThread } from '@/modules/unified-inbox/lib/db'
import {
  allConversationProviders,
  providerPermissionFor,
} from '@/modules/unified-inbox/lib/provider-registry'

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)

  // Reply rather than view: this changes what happens to the next person who
  // gets in touch, which is an act on the outside world rather than a way of
  // reading it. Plus the channel's own permission, same rule as everywhere else
  // in here.
  if (!(await hasPermission(user, 'unifiedinbox.reply'))) return errorResponse('Forbidden', 403)

  const { id } = await ctx.params
  const body = (await request.json().catch(() => null)) as { blocked?: unknown } | null
  const wantBlocked = body?.blocked !== false

  const thread = await getThread(id)
  if (!thread) return errorResponse('Conversation not found', 404)

  // externalId is the conversation as the channel itself knows it - for the
  // phone, that IS the other party's number, which is why blocking a
  // conversation and blocking a caller are the same act.
  if (!thread.providerModule || !thread.externalId) {
    return errorResponse('There is nobody to block on this conversation.', 400)
  }

  const { known, permission } = await providerPermissionFor(thread.providerModule)
  if (!known) {
    return errorResponse(
      'The part of the site that handles this channel is no longer installed, so nobody can be blocked from here.',
      404,
    )
  }
  if (permission && !(await hasPermission(user, permission))) return errorResponse('Forbidden', 403)

  const providers = await allConversationProviders()
  const provider = providers.find((p) => p.moduleName === thread.providerModule)
  if (!provider) return errorResponse('That channel is not available at the moment.', 404)

  const { capabilities, blockParticipant, unblockParticipant, isParticipantBlocked } = provider.provider
  if (!capabilities.block || !blockParticipant || !unblockParticipant) {
    return errorResponse('This channel cannot refuse anybody.', 400)
  }

  try {
    if (wantBlocked) await blockParticipant(thread.externalId)
    else await unblockParticipant(thread.externalId)
  } catch (err) {
    // A channel throws when there is nobody to block - a caller who withheld
    // their number, say - and its own words are the useful ones here, because
    // only it knows why.
    const message = err instanceof Error && err.message ? err.message : 'That could not be done just now.'
    return errorResponse(message, 400)
  }

  const blocked = isParticipantBlocked
    ? await isParticipantBlocked(thread.externalId)
    : wantBlocked

  return NextResponse.json({ ok: true, blocked })
}
