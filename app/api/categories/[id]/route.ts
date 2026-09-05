import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import {
  deleteCategory,
  findCategoryByName,
  getCategory,
  renameCategory,
} from '@/modules/unified-inbox/lib/db'
import { CategoryBody } from '@/modules/unified-inbox/lib/validation'

// One label, renamed or removed.
//
// Removing one keeps everybody who was wearing it: a category is something
// somebody said ABOUT a contact, never the contact. The join table's cascade
// does that on its own - see migrations/026_contact_categories.sql.

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  // Renaming changes what everybody wearing it is called, which is wider than
  // putting one on a card - so it takes the wider grant, and deleting does too.
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const category = await getCategory(id)
  if (!category) return errorResponse('That category is no longer here.', 404)

  const parsed = CategoryBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That does not look right.')

  const clash = await findCategoryByName(parsed.data.name)
  if (clash && clash.id !== category.id) {
    return errorResponse('There is already a category with that name.')
  }

  await renameCategory(category.id, parsed.data.name)
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const category = await getCategory(id)
  if (!category) return errorResponse('That category is no longer here.', 404)

  await deleteCategory(category.id)
  return NextResponse.json({ ok: true })
}
