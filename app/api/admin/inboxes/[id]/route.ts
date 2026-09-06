import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { adoptUnroutedFolderMail, addressTakenBy, deleteInbox, getInbox, updateInbox } from '@/modules/unified-inbox/lib/db'
import { isValidAddress } from '@/modules/unified-inbox/lib/addresses'
import { InboxPatchBody } from '@/modules/unified-inbox/lib/validation'
import { cleanSignatureHtml } from '@/modules/unified-inbox/lib/signature'
import { senderWarningFor } from '@/modules/unified-inbox/lib/sender-warning'
import { kindProblem, ownerProblem, settleIndividualAudience } from '@/modules/unified-inbox/lib/inbox-kind'

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const before = await getInbox(id)
  if (!before) return errorResponse('That inbox no longer exists.', 404)

  const parsed = InboxPatchBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('Those inbox details do not look right.')
  if (parsed.data.address !== undefined) {
    if (!isValidAddress(parsed.data.address)) return errorResponse('That does not look like an email address.')
    if (await addressTakenBy(parsed.data.address, id)) {
      return errorResponse('There is already an inbox for that address.')
    }
  }

  // An edit sends some of the form, so the kind is judged on what the inbox
  // WOULD be rather than on what arrived: turning on the catch-all without
  // mentioning the kind, and making it somebody's own without mentioning the
  // catch-all, are the same mistake arriving from either end.
  const kind = parsed.data.kind ?? before.kind
  const ownerUserId = kind === 'individual'
    ? parsed.data.ownerUserId ?? (before.kind === 'individual' ? before.ownerUserId : null)
    : null
  const problem = kindProblem({
    kind,
    ownerUserId,
    isCatchAll: parsed.data.isCatchAll ?? before.isCatchAll,
  })
  if (problem) return errorResponse(problem)
  if (ownerUserId && ownerUserId !== before.ownerUserId) {
    const owner = await ownerProblem(ownerUserId)
    if (owner) return errorResponse(owner)
  }

  const inbox = await updateInbox(id, {
    ...parsed.data,
    ...(parsed.data.kind !== undefined || parsed.data.ownerUserId !== undefined
      ? { kind, ownerUserId }
      : {}),
    ...(parsed.data.signatureHtml !== undefined
      ? { signatureHtml: cleanSignatureHtml(parsed.data.signatureHtml) }
      : {}),
  })
  if (!inbox) return errorResponse('That inbox no longer exists.', 404)

  await settleIndividualAudience(inbox)

  // Switching the folder rule ON also sweeps up what is already sitting in that
  // folder with nowhere to go. Somebody turning this on has a specific email in
  // mind, and that email was collected before the setting existed - a message
  // is read once and never asked about again, so nothing else would ever go
  // back for it.
  const adopted = inbox.folderOwnsMail && !before.folderOwnsMail
    ? await adoptUnroutedFolderMail(inbox.id)
    : 0

  return NextResponse.json({ inbox, adopted, senderWarning: await senderWarningFor(inbox) })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const { id } = await params
  await deleteInbox(id)
  return NextResponse.json({ ok: true })
}
