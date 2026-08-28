import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { mergePeople } from '@/modules/unified-inbox/lib/db'

// Folding one person into another.
//
// Behind `unifiedinbox.manage` rather than the everyday reply permission: this
// is the operation people regret, and although it can be taken back, the person
// who set the inbox up is the one who should be doing it.
//
// The losing row is kept, not deleted - see mergePeople - so what this returns
// is a merge id, and that id is what puts it all back.

const Body = z.object({ loserId: z.string().min(1) })

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('Pick somebody to merge in.')

  const result = await mergePeople(id, parsed.data.loserId, user.id)
  if ('error' in result) return errorResponse(result.error)

  return NextResponse.json({
    ok: true,
    mergeId: result.mergeId,
    message: 'Merged. You can put this back from the person page if it was wrong.',
  })
}
