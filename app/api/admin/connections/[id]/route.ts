import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { deleteConnection, getConnection, updateConnection } from '@/modules/unified-inbox/lib/db'

const Body = z.object({
  label: z.string().min(1).max(120).optional(),
  imapHost: z.string().min(1).max(255).optional(),
  imapPort: z.number().int().min(1).max(65535).optional(),
  imapUsername: z.string().min(1).max(255).optional(),
  // Omitted means "keep the password there is"; the screen never sends the
  // stored one back, because it never receives it.
  imapPassword: z.string().min(1).optional(),
  imapTls: z.boolean().optional(),
  extraFolders: z.array(z.string().min(1)).optional(),
})

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const { id } = await params
  if (!await getConnection(id)) return errorResponse('That mail account no longer exists.', 404)

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('Those mail account details do not look right.')

  return NextResponse.json({ connection: await updateConnection(id, parsed.data) })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const { id } = await params
  // Inboxes served by this account keep their conversations and simply stop
  // collecting new mail until they are pointed somewhere else. Deleting the
  // account is not a reason to lose a customer's email history.
  await deleteConnection(id)
  return NextResponse.json({ ok: true })
}
