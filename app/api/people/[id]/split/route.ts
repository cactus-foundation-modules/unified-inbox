import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { splitPerson } from '@/modules/unified-inbox/lib/db'

// Taking some addresses off a person and giving them to a new one.
//
// The other half of a mis-merge, and the answer when what looked like one
// person turns out to have been two sharing a mailbox. Conversations follow the
// address they were had with, which is what somebody splitting two people apart
// means by splitting them apart.

const Body = z.object({ identityIds: z.array(z.string().min(1)).min(1).max(50) })

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('Pick at least one address to move.')

  const result = await splitPerson(id, parsed.data.identityIds, user.id)
  if ('error' in result) return errorResponse(result.error)

  return NextResponse.json({ ok: true, personId: result.personId, message: 'Split.' })
}
