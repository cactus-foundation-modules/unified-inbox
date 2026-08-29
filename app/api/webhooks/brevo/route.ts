import { timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getBrevoWebhookSecret, getSettings, recordDeliveryEvent } from '@/modules/unified-inbox/lib/db'
import { normaliseBrevoEvent } from '@/modules/unified-inbox/lib/receipts'

// ---------------------------------------------------------------------------
// Where Brevo tells us what became of a reply.
//
// Brevo does not sign what it sends, so the address carries a long random token
// that has to match - the same arrangement the live chat module uses, for the
// same reason. A request without it is refused before anything is parsed.
//
// Everything else answers 200, including the events this module has no opinion
// about and the ones about messages it has never heard of. Most of what arrives
// is the second kind: the site's Brevo account also carries order
// confirmations, purchase orders and password resets, and none of those are
// conversations. Answering anything other than 200 to those would have Brevo
// retrying them for hours.
// ---------------------------------------------------------------------------

export const dynamic = 'force-dynamic'

function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  // Different lengths cannot be compared safely, and are wrong anyway.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function POST(request: NextRequest) {
  const expected = await getBrevoWebhookSecret()
  const token = request.nextUrl.searchParams.get('token') ?? ''
  if (!expected || !token || !tokenMatches(token, expected)) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 })
  }

  // Switched off since the webhook was registered - reconciling should have
  // removed it, but a key that was rejected that day leaves one behind, and a
  // site that has said no should not quietly keep collecting.
  const settings = await getSettings()
  if (!settings.trackOpens) return NextResponse.json({ ok: true, ignored: 'not-collecting' })

  const body = await request.json().catch(() => null)
  const events = Array.isArray(body) ? body : [body]

  let filed = 0
  for (const entry of events.slice(0, 100)) {
    const normalised = normaliseBrevoEvent(entry)
    if (!normalised) continue
    try {
      const recorded = await recordDeliveryEvent(normalised.messageId, {
        ...normalised.event,
        source: 'brevo',
      })
      if (recorded) filed += 1
    } catch (err) {
      // One bad event must not cost the rest of the batch, and must not turn
      // into a retry storm: Brevo redelivers anything it is not thanked for.
      console.error('[unified-inbox] could not file a delivery event', err)
    }
  }

  return NextResponse.json({ ok: true, filed })
}
