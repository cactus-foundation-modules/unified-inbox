import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getPerson } from '@/modules/unified-inbox/lib/db'
import { erasePerson, personErasePreview } from '@/modules/unified-inbox/lib/person-data'

// Taking away everything the hub holds about one person (D17).
//
// Two verbs on purpose. GET answers "what exactly would go", counted from the
// very tables the delete runs against, and POST does it. The screen asks the
// first question before it offers the second, so nobody presses a button whose
// consequences are described only in general terms.
//
// It is HUB-ONLY and says so, at every step (E22). Their orders, invoices,
// quotes and member account are held by other parts of the site and are not
// touched here, and neither is core's record that automated mail was sent -
// which holds an address and a subject and never a body. Pretending otherwise
// would be the worse failure of the two: a person who asked to be forgotten and
// silently took three years of order history with them is a problem nobody can
// undo, and one that a refusal would never have caused.
export const maxDuration = 60

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const preview = await personErasePreview(id)
  if (!preview) return errorResponse('That person is no longer here.', 404)

  return NextResponse.json({ ok: true, preview })
}

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const person = await getPerson(id)
  if (!person) return errorResponse('That person is no longer here.', 404)

  const outcome = await erasePerson(person.id)

  // A trace that it happened, without naming who it happened to - an audit row
  // holding the name of somebody who has just been erased would be the thing
  // this whole route exists to remove.
  console.info(
    `[unified-inbox] ${user.id} erased a person: ${outcome.conversations} conversation(s), ` +
    `${outcome.storedObjects} stored file(s) removed, ${outcome.storedObjectFailures} could not be`,
  )

  return NextResponse.json({
    ok: true,
    conversations: outcome.conversations,
    message: outcome.storedObjectFailures > 0
      ? 'Erased. Some of their attached files could not be removed from storage and will be picked up by the storage check.'
      : 'Erased.',
  })
}
