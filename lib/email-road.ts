import { providerForKey } from './provider-registry'
import { answersByEmail } from './channel-reply'
import { replyAnchorSource } from './db'
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

/**
 * The conversation as this particular reply should be routed, and whether the
 * reply is an email that merely sits on a channel's conversation.
 *
 * Two things make a reply on a channel's conversation an email. The message
 * being answered came in by mail (see `answersByEmail` - an email merged into a
 * chat). Or the reply carries a subject: a channel that takes no subject never
 * has one, so a subject on a reply to a chat is somebody having picked "reply
 * by email" on it. Said that way, rather than with a flag, so a saved or
 * scheduled draft - which carries the subject - sends the way it was written.
 * A channel answered by email already takes a subject, and is left alone.
 *
 * Either way the thread comes back with no channel, so it takes the email road.
 */
export async function routedThread<T extends ThreadShape & { providerModule: string | null }>(
  thread: T | null,
  options: { inReplyToMessageId?: string | null; subject?: string | null } = {},
): Promise<{ thread: T | null; byEmail: boolean }> {
  if (!thread?.providerModule) return { thread, byEmail: false }
  const channel = await providerForKey(thread.providerModule)
  const filed = threadAccessKind(thread) === 'filed'
  if (channel?.provider.capabilities?.email !== true && options.subject?.trim()) {
    return { thread: { ...thread, providerModule: null }, byEmail: true }
  }
  if (!filed) return { thread, byEmail: false }
  const source = await replyAnchorSource(thread.id ?? '', options.inReplyToMessageId)
  return answersByEmail({ providerModule: thread.providerModule, filed }, source === null ? null : { source })
    ? { thread: { ...thread, providerModule: null }, byEmail: true }
    : { thread, byEmail: false }
}
