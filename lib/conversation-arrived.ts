import type { ConversationArrivedEvent } from '@/lib/conversations/arrived'
import { getSiteUrlOrNull } from '@/lib/config/env'

// What this module does when another module says one of its conversations has
// something new in it (`core.conversation-arrived`): copies that channel across
// at once, instead of leaving it for the hourly sync or a press of Check now.
// A contact-form enquiry or a chat then lands in the inbox while the visitor is
// still reading the thank-you.
//
// By asking this module's own route (app/api/channel-arrived) rather than
// importing the sync. This file is named in the generated server registry, and
// public pages read that registry: an import from here, lazy or not, put the
// whole collection path - and the 3D viewer the provider registry reaches -
// into every public page's client graph (lib/modules/public-graph-weight.test.ts).
// A request has no such edge. Only the announcing channel is copied and no
// mailbox is opened. Never thrown from: core logs a failure, and the hourly
// tick is still there behind it.

export async function unifiedInboxConversationArrived(event: ConversationArrivedEvent): Promise<void> {
  const site = getSiteUrlOrNull()
  const secret = process.env.CRON_SECRET
  if (!site || !secret) return
  const res = await fetch(`${site}/api/m/unified-inbox/channel-arrived`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: event.providerId }),
    signal: AbortSignal.timeout(30_000),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`channel-arrived answered ${res.status}`)
}
