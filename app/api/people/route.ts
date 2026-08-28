import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { listPeople } from '@/modules/unified-inbox/lib/db'

// The people directory, which exists for one purpose: finding the other half of
// a merge. There is no browsing screen and there is not meant to be one - the
// people layer is thin, and a directory of everybody who has ever emailed is
// how a conversation hub quietly turns into a customer database.

export async function GET(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.view')) return errorResponse('Forbidden', 403)

  const search = request.nextUrl.searchParams.get('q')
  const { rows, total } = await listPeople({ search, page: 1, perPage: 20 })

  return NextResponse.json({
    total,
    people: rows.map((p) => ({
      id: p.id,
      name: p.displayName,
      email: p.primaryEmail,
      organisation: p.organisationName,
      conversations: p.threadCount,
    })),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
