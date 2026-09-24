import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { visibleInboxIds } from '@/modules/unified-inbox/lib/access'
import {
  countThreads,
  defaultInboxIdFor,
  getSettings,
  listInboxes,
  type ThreadListFilters,
} from '@/modules/unified-inbox/lib/db'
import { visibleProviderChannels } from '@/modules/unified-inbox/lib/provider-registry'

// Small JSON glance for the Deskwell iOS home-screen widget: unread open threads
// the signed-in user may see, using the same inbox/channel visibility as the inbox UI.
export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.view')) return errorResponse('Forbidden', 403)

  const canManage = await hasPermission(user, 'unifiedinbox.manage')
  const allInboxes = await listInboxes()
  const visibleIds = await visibleInboxIds(user, allInboxes.map((i) => i.id))

  const ownInboxId = await defaultInboxIdFor(user.id)
  const pinned = ownInboxId && visibleIds.includes(ownInboxId) ? ownInboxId : null

  let channelModules: string[] = []
  if (!pinned) {
    const hidden = new Set((await getSettings()).hiddenChannelModules)
    channelModules = (await visibleProviderChannels(user))
      .map((channel) => channel.key)
      .filter((key) => !hidden.has(key))
  }

  const inboxIds = pinned ? [pinned] : visibleIds
  const includeUnrouted = pinned ? false : canManage
  if (inboxIds.length === 0 && channelModules.length === 0 && !includeUnrouted) {
    return NextResponse.json({ unreadOpen: 0 })
  }

  const filters: ThreadListFilters = {
    viewerUserId: user.id,
    inboxIds,
    includeUnrouted,
    providerModules: channelModules,
    inboxId: pinned,
    unreadOnly: true,
    status: 'open',
    page: 1,
    perPage: 1,
  }

  const unreadOpen = await countThreads(filters)
  return NextResponse.json({ unreadOpen })
}
