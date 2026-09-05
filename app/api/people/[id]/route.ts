import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getPerson } from '@/modules/unified-inbox/lib/db'
import { saveContact } from '@/modules/unified-inbox/lib/contact-store'
import { backfillOrganisation } from '@/modules/unified-inbox/lib/identity'
import { ContactBody } from '@/modules/unified-inbox/lib/validation'

// Correcting what we hold about somebody. A name guessed from an address is a
// guess, and the person answering their email is the one who knows.
//
// Every field arrives through the same schema the new-contact form posts, so
// the card cannot save something here that it would have been refused there.

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.reply')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const person = await getPerson(id)
  if (!person) return errorResponse('That person is no longer here.', 404)

  const parsed = ContactBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That does not look right.')

  const { refused } = await saveContact(person.id, parsed.data, { origin: person.origin })
  // A person whose organisation was never worked out gets another go at it now
  // that somebody has touched the record - cheap, and it fills in the gap left
  // by a domain that was not recognised the first time round.
  await backfillOrganisation(person.id)

  return NextResponse.json({ ok: true, refused })
}
