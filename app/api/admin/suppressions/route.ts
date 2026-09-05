import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { isValidAddress, normaliseAddress } from '@/modules/unified-inbox/lib/addresses'
import {
  addSuppression,
  listSuppressions,
  removeSuppression,
  unsubscribeEverywhere,
} from '@/modules/unified-inbox/lib/campaigns/store'
import { SuppressionBody } from '@/modules/unified-inbox/lib/validation'

// The do-not-email list.
//
// Global, and it outlives every campaign on purpose - a campaign being deleted
// must never quietly re-permit mail to somebody who unsubscribed from it.
// Visible here so that "why is that customer not getting anything" has an
// answer somebody can look up, and removable because an address that bounced
// during an outage is an address that works again on Thursday.
export const maxDuration = 60

const PER_PAGE = 50

export async function GET(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.campaigns')) return errorResponse('Forbidden', 403)

  const url = request.nextUrl.searchParams
  const page = Math.max(1, parseInt(url.get('page') ?? '1', 10) || 1)
  const search = (url.get('q') ?? '').trim().slice(0, 200) || null

  const { rows, total } = await listSuppressions({ search, page, perPage: PER_PAGE })
  return NextResponse.json({ ok: true, rows, total, page, perPage: PER_PAGE })
}

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.campaigns')) return errorResponse('Forbidden', 403)

  const parsed = SuppressionBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That address could not be added.')

  const address = normaliseAddress(parsed.data.address)
  if (!isValidAddress(address)) return errorResponse('That does not look like an email address.')

  await addSuppression({
    address,
    reason: 'manual',
    note: parsed.data.note ?? 'Added by hand.',
  })
  // Taken out of whatever is queued as well, or a campaign already running
  // would write to them tomorrow morning regardless.
  const cleared = await unsubscribeEverywhere(address, new Date())

  return NextResponse.json({ ok: true, cleared })
}

export async function DELETE(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.campaigns')) return errorResponse('Forbidden', 403)

  const id = request.nextUrl.searchParams.get('id')
  if (!id) return errorResponse('Which one?')

  // Only the row goes. Anybody already marked unsubscribed on a campaign stays
  // marked: taking an address off this list means "you may write to them
  // again", not "pretend they never asked you to stop".
  await removeSuppression(id)
  return NextResponse.json({ ok: true })
}
