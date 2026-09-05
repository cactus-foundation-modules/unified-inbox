import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { deleteIdentityForPerson, getPerson } from '@/modules/unified-inbox/lib/db'

// Taking a way of reaching somebody off their card - an address that turned out
// to be a colleague's, a number that has been reassigned.
//
// The person is part of the WHERE rather than something checked first and
// trusted after, so an identity id typed into the address bar cannot take an
// address off a different contact.

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; identityId: string }> },
) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.reply')) return errorResponse('Forbidden', 403)

  const { id, identityId } = await params
  const person = await getPerson(id)
  if (!person) return errorResponse('That person is no longer here.', 404)

  const removed = await deleteIdentityForPerson(person.id, identityId)
  if (!removed) return errorResponse('That is not one of theirs.', 404)

  return NextResponse.json({ ok: true })
}
