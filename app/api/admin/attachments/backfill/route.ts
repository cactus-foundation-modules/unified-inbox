import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { backfillAttachments } from '@/modules/unified-inbox/lib/attachment-backfill'
import { unfiledAttachmentCount } from '@/modules/unified-inbox/lib/db'

// Filing the attachments that were stored before they were filed. GET says how
// many are left; POST shifts one batch and says how many are left after it. The
// screen presses POST until the answer is zero - see lib/attachment-backfill.ts
// for why this is a button rather than a job.

export const maxDuration = 60

export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'unifiedinbox.manage'))) return errorResponse('Forbidden', 403)

  return NextResponse.json({ remaining: await unfiledAttachmentCount() })
}

export async function POST() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'unifiedinbox.manage'))) return errorResponse('Forbidden', 403)

  const outcome = await backfillAttachments()
  return NextResponse.json({ ok: true, ...outcome })
}
