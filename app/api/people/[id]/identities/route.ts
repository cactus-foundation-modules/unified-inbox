import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { addIdentity, findPersonByIdentity, getPerson } from '@/modules/unified-inbox/lib/db'
import { identityKey, phoneKey } from '@/modules/unified-inbox/lib/people'
import { IdentityBody } from '@/modules/unified-inbox/lib/validation'

// Another way of reaching one contact: a second address, or the mobile they
// actually answer.
//
// A value somebody else already holds is LEFT WITH THEM and said so plainly.
// Two people claiming one mailbox is a merge for a person to decide on, not
// something to settle by overwriting - and the merge screen is where it gets
// settled.

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.reply')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const person = await getPerson(id)
  if (!person) return errorResponse('That person is no longer here.', 404)

  const parsed = IdentityBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That does not look right.')

  const { kind, value } = parsed.data
  const matchValue = kind === 'email' ? identityKey(value) : phoneKey(value)
  if (!matchValue) {
    return errorResponse(kind === 'email'
      ? 'That does not look like an email address.'
      : 'That does not look like a phone number.')
  }

  const owner = await findPersonByIdentity([matchValue])
  if (owner && owner !== person.id) {
    return errorResponse('Somebody else here already has that. Merge the two if they are the same person.')
  }

  await addIdentity({ personId: person.id, kind, value, matchValue, source: 'manual' })
  return NextResponse.json({ ok: true })
}
