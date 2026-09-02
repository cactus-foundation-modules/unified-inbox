import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import {
  getSharedWebhookState,
  setSharedWebhookCredentials,
} from '@/modules/unified-inbox/lib/webhooks-db'
import { SharedWebhookBody, headerProblem } from '@/modules/unified-inbox/lib/webhook-validation'

// The signing password and extra headers every subscription can share, rather
// than the same key typed into five of them and rotated in five places.
//
// A literal path segment beside `[id]`, which the module router sorts ahead of
// the dynamic one - so this is never mistaken for a subscription whose id
// happens to be "shared".

export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)
  return NextResponse.json(
    { shared: await getSharedWebhookState() },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function PUT(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const parsed = SharedWebhookBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('Those details do not look right.')

  const problem = headerProblem(parsed.data.headers)
  if (problem) return errorResponse(problem)

  return NextResponse.json({ shared: await setSharedWebhookCredentials(parsed.data) })
}
