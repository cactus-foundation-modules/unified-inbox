import { timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import {
  getBrevoWebhookSecret,
  getSettings,
  outboundIdsByProviderMessageId,
  recordDeliveryEvent,
} from '@/modules/unified-inbox/lib/db'
import { normaliseBrevoEvent } from '@/modules/unified-inbox/lib/receipts'
import type { NormalisedBrevoEvent } from '@/modules/unified-inbox/lib/receipts'
import { applyCampaignEvent } from '@/modules/unified-inbox/lib/campaigns/events'
import { sendIdFromTag } from '@/modules/unified-inbox/lib/campaigns/message'

// ---------------------------------------------------------------------------
// Where Brevo tells us what became of a reply.
//
// Brevo does not sign what it sends, so the address carries a long random token
// that has to match - the same arrangement the live chat module uses, for the
// same reason. A request without it is refused before anything is parsed.
//
// Everything else answers 200, including the events this module has no opinion
// about and the ones about messages it has never heard of. Most of what arrives
// is the second kind: the site's Brevo account also carries password resets and
// the site writing to itself, and none of those are conversations. Answering
// anything other than 200 to those would have Brevo retrying them for hours.
//
// An order confirmation, though, IS one - or rather, a copy of it is sitting on
// a conversation in the inbox, because the shop was told to file one there. It
// left without our tag on it, since the shop sent it and this module was handed
// the copy afterwards, so until the batch below started asking, every event
// about one was thrown away: no delivery, no open, and no sign that the
// customer had followed the link to their order. The row does hold the name the
// service gave the message, and that is what the events are matched on instead.
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
  //
  // Campaign BOUNCES are the one exception and are taken either way. Watching
  // whether somebody opened an email is tracking and is off until a site asks
  // for it; being told an address does not exist is the mail system reporting a
  // failure, and a site that ignores those goes on writing to dead addresses
  // until its own domain is the thing being blocked.
  const settings = await getSettings()

  const body = await request.json().catch(() => null)
  const events = Array.isArray(body) ? body : [body]

  const normalised = events
    .slice(0, 100)
    .map((entry) => normaliseBrevoEvent(entry))
    .filter((one): one is NormalisedBrevoEvent => one !== null)

  // The untagged ones, looked up together. Brevo batches its events, so this is
  // one query where it was going to be one per event - and on a busy site most
  // of them will find nothing, which is the answer arriving for free rather
  // than a miss costing a round trip each. Skipped entirely when the site is
  // not watching, since nothing would be filed with the answer anyway.
  const untagged = settings.trackOpens
    ? normalised.flatMap((one) => (!one.messageId && one.providerMessageId ? [one.providerMessageId] : []))
    : []
  const byProviderId = await outboundIdsByProviderMessageId(untagged)

  let filed = 0
  for (const one of normalised) {
    try {
      // A campaign send carries its own tag, so one is told from an ordinary
      // reply without looking anything up.
      const campaignSendId = one.messageId ? sendIdFromTag(one.messageId) : null
      if (campaignSendId) {
        if (one.event.kind !== 'bounced' && !settings.trackOpens) continue
        if (await applyCampaignEvent(campaignSendId, one.event)) filed += 1
        continue
      }
      if (!settings.trackOpens) continue
      const messageId = one.messageId
        ?? (one.providerMessageId ? byProviderId.get(one.providerMessageId) ?? null : null)
      // Somebody else's mail, which is most of it.
      if (!messageId) continue
      const recorded = await recordDeliveryEvent(messageId, { ...one.event, source: 'brevo' })
      if (recorded) filed += 1
    } catch (err) {
      // One bad event must not cost the rest of the batch, and must not turn
      // into a retry storm: Brevo redelivers anything it is not thanked for.
      console.error('[unified-inbox] could not file a delivery event', err)
    }
  }

  return NextResponse.json({ ok: true, filed })
}
