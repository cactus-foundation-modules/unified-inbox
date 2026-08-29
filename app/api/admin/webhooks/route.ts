import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { createWebhook, listWebhooks } from '@/modules/unified-inbox/lib/webhooks-db'
import { checkDestination } from '@/modules/unified-inbox/lib/webhooks'
import {
  WebhookBody,
  headerProblem,
  literalProblem,
} from '@/modules/unified-inbox/lib/webhook-validation'
import type { WebhookEvent } from '@/modules/unified-inbox/lib/webhook-types'

export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)
  return NextResponse.json(
    { webhooks: await listWebhooks() },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const parsed = WebhookBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('Those webhook details do not look right.')

  const problem =
    headerProblem(parsed.data.headers) ??
    literalProblem(parsed.data.payloadStyle, parsed.data.literalBody)
  if (problem) return errorResponse(problem)

  // Checked here as well as before each send. Refusing it now means the person
  // who typed it is still standing here to fix it.
  const destination = await checkDestination(parsed.data.url)
  if (!destination.ok) return errorResponse(destination.why)

  const webhook = await createWebhook({
    ...parsed.data,
    events: parsed.data.events as WebhookEvent[],
  })
  return NextResponse.json({ webhook }, { status: 201 })
}
