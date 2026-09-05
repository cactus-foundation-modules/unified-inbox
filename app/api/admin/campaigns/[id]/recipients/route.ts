import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getCampaign, listRecipients, listSendsForRecipient } from '@/modules/unified-inbox/lib/campaigns/store'
import { RECIPIENT_STATES, type RecipientState } from '@/modules/unified-inbox/lib/campaigns/types'

// The Watch table: everybody on the campaign and where they have got to.
//
// Paged, because a campaign is five thousand rows and a screen is thirty. The
// filter is a state rather than a search over states - "show me the ones that
// bounced" is the question, and it is answered by an index rather than by
// reading the lot.
export const maxDuration = 60

const PER_PAGE = 50

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.campaigns')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const campaign = await getCampaign(id)
  if (!campaign) return errorResponse('That campaign is no longer here.', 404)

  const url = request.nextUrl.searchParams
  const rawState = url.get('state')
  const state = rawState && (RECIPIENT_STATES as readonly string[]).includes(rawState)
    ? rawState as RecipientState
    : null
  const page = Math.max(1, parseInt(url.get('page') ?? '1', 10) || 1)
  const search = (url.get('q') ?? '').trim().slice(0, 200) || null

  const { rows, total } = await listRecipients(id, { state, search, page, perPage: PER_PAGE })

  // What went to one person, when a row is opened. Only for the page on screen,
  // which is fifty queries at worst and none at all until somebody asks.
  const detail = url.get('detail')
  const sends = detail ? await listSendsForRecipient(detail) : []

  return NextResponse.json({
    ok: true,
    rows,
    total,
    page,
    perPage: PER_PAGE,
    sends,
  })
}
