import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import {
  getInbox,
  listInboxAccess,
  listUserDefaultInboxes,
  setInboxAudience,
} from '@/modules/unified-inbox/lib/db'

// Who one inbox is for: who may read it, and whose own address it is.
//
// An empty guest list is meaningful: it hands the inbox back to everybody with
// permission to view the hub at all, which is what a one-person site wants and
// what every inbox starts as.
//
// The two facts travel together because they are one group of tick boxes and
// one Save. They are stored apart, though - see lib/db.ts - because naming
// somebody's own address must not quietly turn an open inbox into a private
// one.

/** Whose own address this inbox is, out of every such row on the site. */
async function defaultUserIdsFor(inboxId: string): Promise<string[]> {
  const rows = await listUserDefaultInboxes()
  return rows.filter((r) => r.inboxId === inboxId).map((r) => r.userId)
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const [access, defaultUserIds] = await Promise.all([listInboxAccess(id), defaultUserIdsFor(id)])
  return NextResponse.json({ access, defaultUserIds }, { headers: { 'Cache-Control': 'no-store' } })
}

const Body = z.object({
  entries: z.array(z.object({
    userId: z.string().min(1),
    canReply: z.boolean().default(true),
  })).max(500),
  // Optional so an older screen posting only a guest list still saves one,
  // rather than silently clearing whoever calls this address their own.
  defaultUserIds: z.array(z.string().min(1)).max(500).optional(),
})

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const { id } = await params
  if (!await getInbox(id)) return errorResponse('That inbox no longer exists.', 404)

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That access list does not look right.')

  const defaults = parsed.data.defaultUserIds ?? await defaultUserIdsFor(id)
  await setInboxAudience(id, parsed.data.entries, [...new Set(defaults)])

  const [access, defaultUserIds] = await Promise.all([listInboxAccess(id), defaultUserIdsFor(id)])
  return NextResponse.json({ access, defaultUserIds })
}
