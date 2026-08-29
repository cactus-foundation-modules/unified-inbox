import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { addressTakenBy, createInbox, listInboxes } from '@/modules/unified-inbox/lib/db'
import { isValidAddress } from '@/modules/unified-inbox/lib/addresses'
import { InboxBody } from '@/modules/unified-inbox/lib/validation'
import { cleanSignatureHtml } from '@/modules/unified-inbox/lib/signature'
import { senderWarningFor } from '@/modules/unified-inbox/lib/sender-warning'

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

  // Pasted markup is cleaned on the way in rather than on the way out: what is
  // stored is then what was checked, and every later reader gets the same
  // markup without having to remember to clean it again.
  const inbox = await createInbox({
    ...parsed.data,
    ...(parsed.data.signatureHtml !== undefined
      ? { signatureHtml: cleanSignatureHtml(parsed.data.signatureHtml) }
      : {}),
  })

  // Checked now, while the person who can fix it is the one standing here
  // (E15). Never blocks the save - an inbox that cannot send yet still
  // collects mail perfectly well.
  return NextResponse.json(
    { inbox, senderWarning: await senderWarningFor(inbox) },
    { status: 201 },
  )
}
