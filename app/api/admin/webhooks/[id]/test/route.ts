import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getWebhook, recordWebhookOutcome } from '@/modules/unified-inbox/lib/webhooks-db'
import { bodyFor, deliverOnce } from '@/modules/unified-inbox/lib/webhooks'
import type { MessageReceivedPayload } from '@/modules/unified-inbox/lib/webhook-types'

// Send one now, with the same code path the scheduled sender uses, so what a
// test proves is exactly what the real thing will do. The payload is made up
// and says so in its own fields - nobody's actual post is sent to prove a URL
// works.
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const webhook = await getWebhook(id)
  if (!webhook) return errorResponse('That webhook no longer exists.', 404)

  const site = process.env.SITE_URL ?? ''
  const sample: MessageReceivedPayload = {
    event: 'message.received',
    at: new Date().toISOString(),
    site,
    inbox: { id: webhook.inboxId, name: 'Test', address: 'test@example.com' },
    conversation: { id: 'test-conversation', subject: 'A test from your website', url: null },
    message: {
      id: 'test-message',
      channel: 'email',
      direction: 'in',
      from: { name: 'Test Sender', address: 'test@example.com', phone: null },
      subject: 'A test from your website',
      snippet: 'This is a test. No real message was sent.',
      sentAt: new Date().toISOString(),
      hasAttachments: false,
      ...(webhook.includeBody ? { bodyText: 'This is a test. No real message was sent.' } : {}),
    },
  }

  const result = await deliverOnce(webhook, bodyFor(webhook, { style: 'event', body: sample }))

  // A test counts. An endpoint that answers proves the run of failures is over,
  // and one that does not should show on the screen like any other attempt.
  await recordWebhookOutcome(webhook.id, {
    ok: result.ok,
    status: result.ok ? String(result.status) : (result.status === null ? 'no answer' : String(result.status)),
    error: result.ok ? null : result.error,
    autoDisableAfter: Number.MAX_SAFE_INTEGER,
  })

  return NextResponse.json(result.ok
    ? { ok: true, status: result.status }
    : { ok: false, status: result.status, error: result.error })
}
