import { isPermanentBounce } from './replies'
import { addSuppression, markAddressBounced, recordSendEvent } from './store'

// ---------------------------------------------------------------------------
// What the mail service later says about a campaign message.
//
// The same events the rest of the module already files against a reply, applied
// to a send instead - and with one thing the reply path does not have to do:
// deciding whether an address is dead for good.
//
// THE DISTINCTION THAT MATTERS is hard against soft. A hard bounce, an invalid
// address or a block means never write here again, and it goes on the
// suppression list for every campaign this site will ever send. A soft bounce
// is a full mailbox on a Tuesday and the address is perfectly good on
// Wednesday; suppressing on one of those loses a customer permanently over a
// temporary problem, which is the more expensive mistake of the two.
//
// A SPAM COMPLAINT is kept apart from an unsubscribe, because the number of
// them is what decides whether the domain keeps working, and averaging the two
// together hides exactly the number somebody needs to see.
// ---------------------------------------------------------------------------

export type CampaignEvent = {
  kind: 'delivered' | 'opened' | 'proxy_open' | 'bounced' | 'receipt'
  occurredAt: Date
  bounceKind?: string | null
  detail?: string | null
}

/**
 * File one event against one send.
 *
 * Returns whether anything was recorded, so the webhook can say how many of a
 * batch it recognised. Never throws: an event about a message this site no
 * longer holds is an ordinary thing to receive and must not turn into a retry
 * storm from the mail service.
 */
export async function applyCampaignEvent(sendId: string, event: CampaignEvent): Promise<boolean> {
  // A proxy open is a mail app prefetching the picture rather than a person
  // reading it. The hub keeps the distinction on a reply; on a campaign it is
  // simply not counted, because "how many opened it" is a number people make
  // decisions with and half of it being Apple's image cache is worse than not
  // having it.
  const kind = event.kind === 'delivered' || event.kind === 'opened' || event.kind === 'bounced'
    ? event.kind
    : null
  if (!kind) return false

  const send = await recordSendEvent(sendId, {
    kind,
    occurredAt: event.occurredAt,
    bounceKind: event.bounceKind ?? null,
    detail: event.detail ?? null,
  })
  if (!send) return false

  if (kind !== 'bounced') return true

  // A complaint is its own thing and is treated as harshly as it deserves: off
  // the list for good, and counted separately.
  if (event.bounceKind === 'spam') {
    await addSuppression({
      address: send.address,
      reason: 'complained',
      campaignId: send.campaignId,
      note: 'They marked one of these emails as spam.',
    })
    await markAddressBounced(send.address, event.occurredAt, 'They marked it as spam.')
    return true
  }

  if (isPermanentBounce(event.bounceKind)) {
    await addSuppression({
      address: send.address,
      reason: 'bounced',
      campaignId: send.campaignId,
      note: event.detail ?? 'The mail service said this address does not exist.',
    })
    await markAddressBounced(
      send.address,
      event.occurredAt,
      'The address does not work - the mail service sent it straight back.',
    )
  }

  return true
}
