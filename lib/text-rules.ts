import { toE164 } from '@/lib/phone'
import type { ConversationMessage } from '@/lib/conversations/types'

// The rules behind texting somebody from an email conversation, kept away from
// the database so both halves of the app can use them and a test can argue
// with them. The why of all of it is at the top of lib/text-links.ts.

/** A conversation filed under a channel of its own - the phone one, a text-only
 *  one - rather than one a text is carried on the side of. */
export function isTextChannel(channel: string | null | undefined): boolean {
  return channel === 'sms' || channel === 'phone'
}

/**
 * Whether one message is a text carried on an email conversation, rather than
 * the conversation's own kind of message. Such a message has no address, so it
 * is never what an email reply answers or quotes, and it is answered with a
 * text instead.
 */
export function isSideText(
  message: { channel: string; direction: string },
  threadChannel: string,
): boolean {
  return message.direction !== 'note' && message.channel === 'sms' && !isTextChannel(threadChannel)
}

/**
 * The number on a contact's card that can be sent a text, in the shape the
 * channel wants, or null when none of them can.
 *
 * On a UK site that is a mobile - 07, or the same thing written +44 7 - and a
 * landline is passed over rather than offered: a text to a landline is either
 * refused by the network or read out by a robot voice, and neither is what
 * anybody pressing "Send text message" meant. Anywhere else there is no rule
 * this simple for telling the two apart, so any number that reads as one is
 * offered and the channel refuses what it cannot deliver.
 */
export function textableNumber(values: readonly string[], diallingCode: string): string | null {
  const uk = diallingCode.replace(/\D/g, '').replace(/^00/, '') === '44'
  for (const value of values) {
    const e164 = toE164(value, diallingCode)
    if (!e164) continue
    if (uk && !e164.startsWith('+447')) continue
    return e164
  }
  return null
}

/**
 * Whether the channel says this message is a text. The kind is optional on the
 * contract, and a channel that does not say is read by its conversation: one
 * made of texts alone is a text conversation, so everything in it is a text.
 * Anything else unmarked - a call log from a channel that predates the field -
 * is not treated as one.
 *
 * Read loosely on purpose. `medium` arrived in core after this module's
 * earliest supported core, and a site building this against a core that does
 * not know the field must still build.
 */
export function isTextMessage(message: ConversationMessage, conversationChannel: string): boolean {
  const medium = (message as { medium?: unknown }).medium
  if (medium === 'text') return true
  if (medium === undefined || medium === null) return conversationChannel === 'sms'
  return false
}

export type TextLink = {
  phone: string
  /** Where redirected texts go - the linked conversation, or what it has since
   *  been merged into. */
  threadId: string
  since: Date
  endedAt: Date | null
  providerModule: string | null
  externalId: string | null
  seenThrough: Date | null
}

/** Whether this message is redirected by this note: a live note, a text, and
 *  dated on or after the moment the first text was sent. */
export function redirectsTo(
  link: TextLink,
  message: ConversationMessage,
  sentAt: Date,
  conversationChannel: string,
): boolean {
  if (link.endedAt) return false
  if (!isTextMessage(message, conversationChannel)) return false
  return sentAt.getTime() >= link.since.getTime()
}

/** How far a linked phone conversation has been read: settled when nothing in
 *  it has happened since. */
export function linkSettled(link: TextLink, lastMessageAt: Date, contentAt: Date): boolean {
  if (!link.seenThrough) return false
  const newest = Math.max(lastMessageAt.getTime(), contentAt.getTime())
  return link.seenThrough.getTime() >= newest
}

