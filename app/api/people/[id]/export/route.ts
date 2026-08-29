import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getPerson } from '@/modules/unified-inbox/lib/db'
import { exportFilename, exportPerson } from '@/modules/unified-inbox/lib/person-data'

// Everything held about one person, as a file (D17).
//
// Behind `unifiedinbox.manage` rather than the everyday view permission, and
// deliberately NOT filtered by the inbox guest lists: this answers a legal
// request about a named human, and an export that quietly left out the inboxes
// this particular administrator happens not to be on would be a false answer to
// it. Whoever may administer the hub may export from it; nobody else can.
//
// Downloading a customer's whole correspondence is a serious thing, so it costs
// the strongest permission the module has and it is never a side effect of
// looking at a page.
export const maxDuration = 60

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const person = await getPerson(id)
  if (!person) return errorResponse('That person is no longer here.', 404)

  const data = await exportPerson(person.id)
  if (!data) return errorResponse('That person is no longer here.', 404)

  console.info(`[unified-inbox] ${user.id} exported everything held about person ${person.id}`)

  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${exportFilename(person)}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
