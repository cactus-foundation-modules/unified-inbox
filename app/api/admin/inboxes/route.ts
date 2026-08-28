import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { addressTakenBy, createInbox, listInboxes } from '@/modules/unified-inbox/lib/db'
import { isValidAddress } from '@/modules/unified-inbox/lib/addresses'
import { InboxBody } from '@/modules/unified-inbox/lib/validation'

export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)
  return NextResponse.json({ inboxes: await listInboxes() }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const parsed = InboxBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('Those inbox details do not look right.')
  if (!isValidAddress(parsed.data.address)) return errorResponse('That does not look like an email address.')
  if (await addressTakenBy(parsed.data.address)) {
    return errorResponse('There is already an inbox for that address.')
  }

  return NextResponse.json({ inbox: await createInbox(parsed.data) }, { status: 201 })
}
