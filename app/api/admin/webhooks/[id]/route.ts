import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { deleteWebhook, updateWebhook } from '@/modules/unified-inbox/lib/webhooks-db'
import { checkDestination } from '@/modules/unified-inbox/lib/webhooks'
import {
  WebhookPatchBody,
  headerProblem,
  literalProblem,
} from '@/modules/unified-inbox/lib/webhook-validation'
import type { WebhookEvent } from '@/modules/unified-inbox/lib/webhook-types'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const parsed = WebhookPatchBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('Those webhook details do not look right.')

  const problem =
    headerProblem(parsed.data.headers) ??
    (parsed.data.payloadStyle
      ? literalProblem(parsed.data.payloadStyle, parsed.data.literalBody)
      : null)
  if (problem) return errorResponse(problem)

  if (parsed.data.url) {
    const destination = await checkDestination(parsed.data.url)
    if (!destination.ok) return errorResponse(destination.why)
  }

  const webhook = await updateWebhook(id, {
    ...parsed.data,
    events: parsed.data.events as WebhookEvent[] | undefined,
  })
  if (!webhook) return errorResponse('That webhook no longer exists.', 404)
  return NextResponse.json({ webhook })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const { id } = await params
  await deleteWebhook(id)
  return NextResponse.json({ ok: true })
}
