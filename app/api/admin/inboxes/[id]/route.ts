import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { addressTakenBy, deleteInbox, getInbox, updateInbox } from '@/modules/unified-inbox/lib/db'
import { isValidAddress } from '@/modules/unified-inbox/lib/addresses'
import { InboxPatchBody } from '@/modules/unified-inbox/lib/validation'
import { senderWarningFor } from '@/modules/unified-inbox/lib/sender-warning'

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const { id } = await params
  if (!await getInbox(id)) return errorResponse('That inbox no longer exists.', 404)

  const parsed = InboxPatchBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('Those inbox details do not look right.')
  if (parsed.data.address !== undefined) {
    if (!isValidAddress(parsed.data.address)) return errorResponse('That does not look like an email address.')
    if (await addressTakenBy(parsed.data.address, id)) {
      return errorResponse('There is already an inbox for that address.')
    }
  }

  const inbox = await updateInbox(id, parsed.data)
  if (!inbox) return errorResponse('That inbox no longer exists.', 404)
  return NextResponse.json({ inbox, senderWarning: await senderWarningFor(inbox) })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const { id } = await params
  await deleteInbox(id)
  return NextResponse.json({ ok: true })
}
