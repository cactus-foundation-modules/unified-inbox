import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getInbox, listInboxAccess, setInboxAccess } from '@/modules/unified-inbox/lib/db'

// Who may read one inbox. An empty list is meaningful: it hands the inbox back
// to everybody with permission to view the hub at all, which is what a
// one-person site wants and what every inbox starts as.

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const { id } = await params
  return NextResponse.json({ access: await listInboxAccess(id) }, { headers: { 'Cache-Control': 'no-store' } })
}

const Body = z.object({
  entries: z.array(z.object({
    userId: z.string().min(1),
    canReply: z.boolean().default(true),
  })).max(500),
})

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const { id } = await params
  if (!await getInbox(id)) return errorResponse('That inbox no longer exists.', 404)

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That access list does not look right.')

  await setInboxAccess(id, parsed.data.entries)
  return NextResponse.json({ access: await listInboxAccess(id) })
}
