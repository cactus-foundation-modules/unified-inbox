import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getPerson, recordMarketingConsent } from '@/modules/unified-inbox/lib/db'

// Somebody told us by phone, by email or in person whether they want marketing
// email, and a member of staff is putting it on their card.
//
// Recorded as now, so it outranks every order they placed before saying so,
// and with who changed it as the source - consent with no trail is consent
// nobody can show. Only a yes or a no: "never asked" is not something anybody
// can tell us after the fact.

const Body = z.object({ consent: z.boolean() })

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.reply')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const person = await getPerson(id)
  if (!person) return errorResponse('That person is no longer here.', 404)

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That does not look right.')

  const who = (user.displayName ?? user.email ?? '').trim()
  await recordMarketingConsent(person.id, {
    consent: parsed.data.consent,
    at: new Date(),
    source: who ? `Changed by hand by ${who}` : 'Changed by hand',
  })
  return NextResponse.json({ ok: true })
}
