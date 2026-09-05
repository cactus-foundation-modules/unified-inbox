import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { createCategory, findCategoryByName, listCategories } from '@/modules/unified-inbox/lib/db'
import { CategoryBody } from '@/modules/unified-inbox/lib/validation'

// The labels somebody puts on a contact: "Supplier", "Trade customer",
// "Haulier". A short list, read by every card and by the filter above the
// contacts, and made longer by anybody who types a new one onto a card.
//
// Not a pipeline. Nothing moves between these on its own and no other part of
// the site reads them.

export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.view')) return errorResponse('Forbidden', 403)

  const rows = await listCategories()
  return NextResponse.json({
    categories: rows.map((c) => ({ id: c.id, name: c.name, people: c.peopleCount })),
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  // The same grant as correcting a contact. A category typed onto a card is
  // part of writing the card, and a list only an administrator may add to is a
  // list that stays as somebody first imagined it.
  if (!await hasPermission(user, 'unifiedinbox.reply')) return errorResponse('Forbidden', 403)

  const parsed = CategoryBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That does not look right.')

  // Matched on the name however it was typed, so "Supplier" and "supplier" are
  // one category rather than two that have to be unpicked later.
  const existing = await findCategoryByName(parsed.data.name)
  if (existing) return NextResponse.json({ ok: true, id: existing.id, alreadyHere: true })

  const id = await createCategory(parsed.data.name)
  return NextResponse.json({ ok: true, id, alreadyHere: false })
}
