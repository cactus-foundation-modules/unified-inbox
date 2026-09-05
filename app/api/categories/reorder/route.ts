import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { reorderCategories } from '@/modules/unified-inbox/lib/db'
import { CategoryOrderBody } from '@/modules/unified-inbox/lib/validation'

// The order the labels are listed in, everywhere they are listed. The site's
// own order rather than one person's, which is why it takes `manage` - the same
// reasoning as dragging the addresses along the top of the hub.

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const parsed = CategoryOrderBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That does not look right.')

  await reorderCategories(parsed.data.ids)
  return NextResponse.json({ ok: true })
}
