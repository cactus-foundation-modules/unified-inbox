import { providerForKey } from './provider-registry'
import { threadAccessKind, type ThreadShape } from './access'

/**
 * Whether a message on this conversation leaves by this module's own mail road,
 * as plain email from the inbox it is filed in, rather than being handed back
 * to the module that owns the channel.
 *
 * A channel that answers by email normally sends its own reply: the contact
 * form puts it in the site's email design, with the sender's signature, as a
 * message from the site. That is right for an enquiry nobody has filed in an
 * address. Once the enquiry is filed in one - General Enquiries, say - the
 * person answering is writing from that address and the customer should get
 * exactly what they wrote, from it, on the same conversation. It also stops the
 * Sent folder's copy of a channel-sent reply turning up as a second, unmatched
 * conversation.
 *
 * A forward always goes this way: it is a new email to somebody the channel has
 * never heard of.
 */
export async function leavesByEmailRoad(
  thread: (ThreadShape & { providerModule: string | null }) | null,
  mode: string,
): Promise<boolean> {
  if (!thread?.providerModule) return false
  const channel = await providerForKey(thread.providerModule)
  if (channel?.provider.capabilities?.email !== true) return false
  return mode === 'forward' || threadAccessKind(thread) === 'filed'
}
