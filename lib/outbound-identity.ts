import type { OutboundEmailIdentity, OutboundEmailIdentityProvider } from '@/lib/email/identity'
import { getInbox } from './db'
import { getModuleSenderInboxId } from './module-senders'
import { sendingIdentity, transportForInbox } from './transport'

// ---------------------------------------------------------------------------
// Core asking this module who a given module's automatic emails should leave
// as (core.outbound-email-identity - see core's lib/email/identity.ts).
//
// The answer is the inbox a site has chosen on that module's own settings tab,
// dressed exactly as a human reply from that inbox would be: its address, its
// name on replies, its own sending account where it has one, and a Reply-To
// pointing back at it so the answer comes home even when a receiving server
// rewrites the sender.
//
// That last part is the entire point. A purchase order that goes out as
// accounts@ is answered to accounts@, and the supplier's reply lands in the
// inbox the people chasing that order are already reading, in the same thread
// as everything else that supplier has ever said - rather than in the site's
// general post, to be forwarded on by somebody who has no idea what it is.
//
// Silent about every module a site has not chosen an inbox for, which is all of
// them to begin with: null means "leave it to Settings > Emails", and a site
// that never opens these boxes sends exactly what it sent before.
// ---------------------------------------------------------------------------

async function identityFor(moduleName: string): Promise<OutboundEmailIdentity | null> {
  const inboxId = await getModuleSenderInboxId(moduleName)
  if (!inboxId) return null

  // The row is cascaded away with its inbox, so this is only ever null in the
  // gap between a delete and its cascade - but a missing inbox has to mean the
  // site's own address rather than an exception on the way out of a checkout.
  const inbox = await getInbox(inboxId)
  if (!inbox) return null

  const { name, address } = sendingIdentity(inbox)
  // Null means "no name of its own", and core reads an absent name as "keep the
  // site's" - which is what an inbox with nothing in its Name on replies box
  // wants. A null passed through as a value would be a From line reading "null".
  const transport = await transportForInbox(inbox)
  return {
    from: { address, ...(name ? { name } : {}) },
    replyTo: address,
    ...(transport ? { transport } : {}),
  }
}

export const unifiedInboxOutboundIdentity: OutboundEmailIdentityProvider = { identityFor }
