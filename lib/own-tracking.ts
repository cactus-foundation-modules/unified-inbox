import type { EmailTrackingEvent, EmailTrackingListener } from '@/lib/email/tracking/listeners'
import { outboundIdsForTrackingEvent, recordDeliveryEvent, type DeliveryUpdate } from './delivery-events-db'

// ---------------------------------------------------------------------------
// Hearing about opens, clicks and bounces the SITE saw, rather than Brevo.
//
// Core counts opens and clicks itself on mail that goes out over SMTP - an
// invisible picture and a redirect on the site's own domain (core's
// lib/email/tracking) - and reads bounces back out of mailboxes this module
// collects. Every event it sees is offered here, at the extension point
// core.email-tracking-event, and this files it on the ledger the labels under
// a sent reply already read (uin_delivery_events), marked source = 'site' so
// the history can say where it came from.
//
// Reached from core's public open-picture and redirect routes, so it imports
// the database client and the light ledger file and nothing else. Throwing is
// allowed - core steps over a listener that fails - but it should not: an event
// about a message this module never sent simply finds nothing and stops.
// ---------------------------------------------------------------------------

const MODULE_NAME = 'unified-inbox'

/** A campaign send's tracking tag - the same prefix lib/campaigns/message.ts
 *  puts on it. Repeated rather than imported, for the reason above. */
const CAMPAIGN_REF_PREFIX = 'uinc-'

/** The ledger's version of one of core's events. Exported for the test. */
export function deliveryUpdateFor(event: EmailTrackingEvent): DeliveryUpdate {
  if (event.kind === 'bounced') {
    return {
      kind: 'bounced',
      occurredAt: event.occurredAt,
      detail: event.detail,
      // The ledger's own words: a soft bounce is the far end still trying.
      bounceKind: event.bounceKind === 'soft' ? 'deferred' : 'hard',
      source: 'site',
    }
  }
  return {
    kind: event.kind,
    occurredAt: event.occurredAt,
    detail: event.kind === 'clicked' ? event.detail : null,
    bounceKind: null,
    source: 'site',
    ip: event.ip,
    userAgent: event.userAgent,
  }
}

export const ownTrackingListener: EmailTrackingListener = {
  async onTrackingEvent(event) {
    // Only our own refs mean anything here. Another module's ref is its own
    // name for its own message and could, by an unlucky coincidence, equal one
    // of our ids.
    const ref = event.moduleName === MODULE_NAME ? event.ref : null

    // A campaign send, named by its tracking tag rather than by a message row -
    // a mailshot keeps no message of its own (M027). Its opens and clicks go
    // on the send, which is where the campaign's progress table reads them.
    // Loaded only when one arrives: this listener runs on every open of every
    // email the site sends, and the campaign store is not a light import.
    if (ref && ref.startsWith(CAMPAIGN_REF_PREFIX)) {
      const { applyCampaignEvent } = await import('./campaigns/events')
      if (event.kind === 'bounced') {
        await applyCampaignEvent(ref.slice(CAMPAIGN_REF_PREFIX.length), {
          kind: 'bounced',
          occurredAt: event.occurredAt,
          bounceKind: event.bounceKind === 'soft' ? 'soft' : 'hard',
          detail: event.detail,
        })
      } else {
        await applyCampaignEvent(ref.slice(CAMPAIGN_REF_PREFIX.length), {
          kind: event.kind,
          occurredAt: event.occurredAt,
          detail: event.kind === 'clicked' ? event.detail : null,
        })
      }
      return
    }

    const ids = await outboundIdsForTrackingEvent({ ref, emailLogId: event.emailLogId })
    const update = deliveryUpdateFor(event)
    for (const id of ids) await recordDeliveryEvent(id, update)
  },
}
