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
