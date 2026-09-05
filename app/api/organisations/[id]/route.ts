import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import {
  deleteOrganisation,
  findOrganisationByName,
  getOrganisation,
  updateOrganisation,
} from '@/modules/unified-inbox/lib/db'
import { OrganisationPatchBody } from '@/modules/unified-inbox/lib/validation'

// One organisation, corrected or removed.
//
// Removing one keeps everybody who was in it: a contact is not the company they
// work for, and deleting a supplier must not delete the person who answers the
// phone there. The foreign key does that on its own - see 001_initial.sql.

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.reply')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const organisation = await getOrganisation(id)
  if (!organisation) return errorResponse('That organisation is no longer here.', 404)

  const parsed = OrganisationPatchBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That does not look right.')

  if (parsed.data.name) {
    const clash = await findOrganisationByName(parsed.data.name)
    if (clash && clash.id !== organisation.id) {
      return errorResponse('There is already an organisation with that name.')
    }
  }

  await updateOrganisation(organisation.id, parsed.data)
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  // Removing one takes a badge off everybody in it at once, which is a wider
  // act than correcting a contact - so it takes the wider grant.
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const organisation = await getOrganisation(id)
  if (!organisation) return errorResponse('That organisation is no longer here.', 404)

  await deleteOrganisation(organisation.id)
  return NextResponse.json({ ok: true })
}
