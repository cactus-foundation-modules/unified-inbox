import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import {
  createOrganisation,
  findOrganisationByName,
  listOrganisations,
} from '@/modules/unified-inbox/lib/db'
import { OrganisationBody } from '@/modules/unified-inbox/lib/validation'

// The organisations behind the contacts. Most of them arrive on their own, off
// the domain a supplier writes from; this is for the haulier who only ever
// telephones, and for filling in the address the mail never carried.

const MAX_PER_PAGE = 100

export async function GET(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.view')) return errorResponse('Forbidden', 403)

  const sp = request.nextUrl.searchParams
  const page = Math.max(1, parseInt(sp.get('page') ?? '1', 10) || 1)
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, parseInt(sp.get('perPage') ?? '20', 10) || 20))

  const { rows, total } = await listOrganisations({ search: sp.get('q'), page, perPage })

  return NextResponse.json({
    total,
    page,
    perPage,
    organisations: rows.map((o) => ({
      id: o.id,
      name: o.name,
      domain: o.domain,
      email: o.email,
      phone: o.phone,
      website: o.website,
      postcode: o.addressPostcode,
      people: o.peopleCount,
    })),
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.reply')) return errorResponse('Forbidden', 403)

  const parsed = OrganisationBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That does not look right.')

  // Matched on the name before one is created, the same as an import does. Two
  // spellings of one company is the mess that takes an afternoon to unpick.
  const existing = await findOrganisationByName(parsed.data.name)
  if (existing) return NextResponse.json({ ok: true, id: existing.id, alreadyHere: true })

  const id = await createOrganisation({ ...parsed.data, origin: 'hand' })
  return NextResponse.json({ ok: true, id, alreadyHere: false })
}
