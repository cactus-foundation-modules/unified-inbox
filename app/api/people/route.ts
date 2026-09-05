import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { categoriesForPeople, listPeople, type PeopleSort } from '@/modules/unified-inbox/lib/db'
import { saveContact } from '@/modules/unified-inbox/lib/contact-store'
import { backfillOrganisation } from '@/modules/unified-inbox/lib/identity'
import { ContactBody } from '@/modules/unified-inbox/lib/validation'

// The address book, listed and added to.
//
// This route began life as the other half of a merge and nothing else - there
// was no browsing screen on purpose, because a directory of everybody who has
// ever emailed is how a conversation hub quietly turns into a customer
// database. The Contacts screen is that browsing screen, added deliberately and
// with the same limit stated out loud: an address book holds names, numbers and
// where to post something. It holds no stage, no value and no next action, and
// the day it does this has stopped being what was asked for.
//
// Reading takes `view`, the same as reading anything else here. Writing takes
// `reply`: correcting somebody's name is the same class of act as answering
// them, and a hub where only administrators may fix a misspelt surname is a hub
// where nobody fixes it.

const MAX_PER_PAGE = 100

export async function GET(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.view')) return errorResponse('Forbidden', 403)

  const sp = request.nextUrl.searchParams
  const search = sp.get('q')
  // Read defensively: a mistyped ?page= reaching a query as NaN renders an
  // error page instead of page one.
  const page = Math.max(1, parseInt(sp.get('page') ?? '1', 10) || 1)
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, parseInt(sp.get('perPage') ?? '20', 10) || 20))
  const sort: PeopleSort = sp.get('sort') === 'name' ? 'name' : 'recent'
  const organisationId = sp.get('organisation')
  const categoryId = sp.get('category')

  const { rows, total } = await listPeople({
    search, page, perPage, sort, organisationId, categoryId,
  })
  // One query for the whole page's labels rather than one per row.
  const categories = await categoriesForPeople(rows.map((r) => r.id))

  return NextResponse.json({
    total,
    page,
    perPage,
    people: rows.map((p) => ({
      id: p.id,
      name: p.displayName,
      firstName: p.firstName,
      lastName: p.lastName,
      jobTitle: p.jobTitle,
      email: p.primaryEmail,
      phone: p.phone,
      organisation: p.organisationName,
      postcode: p.addressPostcode,
      categories: categories[p.id] ?? [],
      conversations: p.threadCount,
    })),
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.reply')) return errorResponse('Forbidden', 403)

  const parsed = ContactBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That does not look right.')

  // A card with nothing on it is not a contact, and a list of them is worse
  // than no list. Something to call them by, or somewhere to reach them.
  const draft = parsed.data
  if (!draft.firstName && !draft.lastName && !draft.email && !draft.phone && !draft.organisation) {
    return errorResponse('A contact needs a name, an address, a number or an organisation.')
  }

  const { personId, refused } = await saveContact(null, draft, { origin: 'hand' })
  // An address whose domain names a company we already know puts them in it,
  // the same as one worked out from the post would.
  await backfillOrganisation(personId)

  return NextResponse.json({ ok: true, id: personId, refused })
}
