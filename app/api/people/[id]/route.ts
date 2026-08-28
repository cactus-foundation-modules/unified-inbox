import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getPerson, recordPersonEvent, updatePerson } from '@/modules/unified-inbox/lib/db'
import { backfillOrganisation } from '@/modules/unified-inbox/lib/identity'

// Correcting what we worked out about somebody. A name guessed from an address
// is a guess, and the person answering their email is the one who knows.

const Body = z.object({
  displayName: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
})

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.reply')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const person = await getPerson(id)
  if (!person) return errorResponse('That person is no longer here.', 404)

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That does not look right.')

  await updatePerson(person.id, {
    displayName: parsed.data.displayName === '' ? null : parsed.data.displayName,
    notes: parsed.data.notes === '' ? null : parsed.data.notes,
  })
  // A person whose organisation was never worked out gets another go at it now
  // that somebody has touched the record - cheap, and it fills in the gap left
  // by a domain that was not recognised the first time round.
  await backfillOrganisation(person.id)

  return NextResponse.json({ ok: true })
}
