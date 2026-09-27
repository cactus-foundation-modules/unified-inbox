import { setThreadRead } from './db'
import { providerForKey } from './provider-registry'

// Telling the module that owns a conversation that somebody has read it here.
//
// Without this, a channel with no read state of its own - the contact form is
// the plain case - goes on reporting every enquiry as new for ever, and the
// next collection finds a conversation the far end still calls unread and marks
// it unread again. Somebody reads the morning's enquiry, presses Check now an
// hour later, and it is bold again. The hub was right to believe the channel;
// the channel was never told.
//
// Deliberately quiet. Being read is not a change anybody is waiting on, and a
// channel that is down must not take the screen down with it: whoever opened
// the conversation has read it either way, and this hub has already written
// that down. So a refusal is logged and swallowed.
export async function pushProviderRead(thread: {
  providerModule: string | null
  externalId: string | null
}): Promise<void> {
  if (!thread.providerModule || !thread.externalId) return

  const resolved = await providerForKey(thread.providerModule)
  if (!resolved) return
  const { capabilities, markRead } = resolved.provider
  if (!capabilities?.markRead || typeof markRead !== 'function') return

  try {
    await markRead(thread.externalId)
  } catch (err) {
    console.error(`[unified-inbox] ${thread.providerModule} would not mark a conversation read:`, err)
  }
}

/**
 * Mark a conversation read because somebody has just thrown it away - into
 * their bin, or into their spam folder.
 *
 * Something deleted or junked is something dealt with. Left bold, it went on
 * counting in the address's unread number and came back looking new the moment
 * anybody put it back, which reads as post that was never looked at. Read is
 * one flag on the conversation rather than one per person, so this settles it
 * for everybody on the address, exactly as opening it would have.
 *
 * Nothing is written when it is already read, so the far end is only told once.
 * Putting it back out of the bin or the spam folder leaves it read: it has been
 * seen, and a conversation that turned bold again for being rescued would say
 * the opposite.
 */
export async function markReadOnDiscard(thread: {
  id: string
  unread: boolean
  providerModule: string | null
  externalId: string | null
}): Promise<void> {
  if (!thread.unread) return
  await setThreadRead(thread.id, false)
  await pushProviderRead(thread)
}
