import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { canOpenThread } from '@/modules/unified-inbox/lib/access'
import {
  brevoKeysForInbox,
  getSentMessageForHistory,
  listDeliveryEvents,
  setDeliveryEventIps,
} from '@/modules/unified-inbox/lib/db'
import { fetchBrevoMessageHistory } from '@/modules/unified-inbox/lib/brevo-events'
import { mergeDeliveryHistory } from '@/modules/unified-inbox/lib/receipts'

// GET /api/m/unified-inbox/messages/[id]/receipts - the whole history of one
// sent message: every delivery, open, click and bounce, with the moment and
// the network address each came from, for the dialog behind the labels under
// a reply.
//
// Two sources, laid over each other. The ledger this module keeps as events
// arrive, which is always answered from; and Brevo's own event report, asked
// on the spot because it is the only one of the two that knows the address an
// open or a click came from. An address the report knows and the ledger does
// not is written onto the ledger row once, so the second look needs nothing
// from Brevo. The report being unavailable is not a failure here: the ledger
// is shown on its own and the screen says the addresses could not be fetched.
//
// Access is checked here, on this request, for this person - the same rule
// the body route applies, because "who opened the quote" is exactly as private
// as the quote.

export const dynamic = 'force-dynamic'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.view')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const message = await getSentMessageForHistory(id)
  if (!message) return errorResponse('That message no longer exists.', 404)
  if (!await canOpenThread(user, { ...message, id: message.threadId })) {
    return errorResponse('Forbidden', 403)
  }

  const stored = await listDeliveryEvents(id)

  let live = false
  let note: string | null = null
  let reported: Awaited<ReturnType<typeof fetchBrevoMessageHistory>> = { ok: true, events: [] }
  if (message.providerMessageId) {
    reported = await fetchBrevoMessageHistory({
      providerMessageId: message.providerMessageId,
      sentAt: message.sentAt,
      apiKeys: await brevoKeysForInbox(message.inboxId),
    })
    if (reported.ok) live = true
    else note = reported.reason
  } else {
    note = 'This message did not go out through the email service, so only what arrived here can be shown.'
  }

  const { events, learnedIps } = mergeDeliveryHistory(stored, reported.ok ? reported.events : [])
  if (learnedIps.length > 0) {
    // Best effort, and never in the way of the answer: a row that did not take
    // its address is asked again next time.
    await setDeliveryEventIps(learnedIps).catch((err) => {
      console.error('[unified-inbox] could not keep delivery event addresses', err)
    })
  }

  return NextResponse.json({
    live,
    note,
    events: events.map((event) => ({
      id: event.id,
      kind: event.kind,
      source: event.source,
      occurredAt: event.occurredAt.toISOString(),
      detail: event.detail,
      ip: event.ip,
      userAgent: event.userAgent,
    })),
  })
}
