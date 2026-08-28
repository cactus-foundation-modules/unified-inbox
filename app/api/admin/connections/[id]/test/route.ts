import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getConnection } from '@/modules/unified-inbox/lib/db'
import { testConnection } from '@/modules/unified-inbox/lib/imap'

// Opens the mailbox, lists the folders, closes it again. Read only - nothing is
// marked, moved or deleted, here or anywhere else in this module.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const { id } = await params
  if (!await getConnection(id)) return errorResponse('That mail account no longer exists.', 404)

  const result = await testConnection(id)
  // A refused password is a fact about the settings, not a broken request, so
  // it comes back 200 with ok:false and a sentence the owner can act on.
  return NextResponse.json(result)
}
