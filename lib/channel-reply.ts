// What a reply to one conversation is addressed by, and what it can carry.
//
// An email reply is addressed by typing an address, may be formatted, may carry
// files and may be forwarded to somebody else. A reply on a channel another
// module owns is none of those things: it goes back down the conversation it
// came from, `sendProviderReply` hands the owning module ONE STRING and nothing
// else, and the send route refuses a forward outright. The composer was built
// for the first kind and was being drawn for both.
//
// THE DEFECT THIS FIXES. A WhatsApp conversation has a number at the far end
// and no email address anywhere on it, so `replyRecipients` came back empty,
// the To box opened blank, and `nobodyToSendTo` disabled Send, Send later and
// the snooze-and-send menu. There was no address to type that would have helped
// either: the send route ignores `to` on a provider conversation entirely. So
// WhatsApp could be read and could not be answered, and the same was true of a
// text or a call. On a live chat or an enquiry it happened to work, because
// those channels carry an email address that filled the box - with an address
// nothing on the server ever read.
//
// So the addressing question is not "does this channel have an address", it is
// "who decides where this goes" - and on every conversation another module owns
// the answer is the conversation itself.
//
// Pure, and no imports: it is read by the reading pane on the server and by the
// composer in the browser, and both have to reach the same answer.

/** How a reply to one conversation is written and what survives the journey. */
export type ReplyStyle = {
  /** Whether somebody types who it goes to. False means the conversation
   *  decides, and there is no To, Cc, Bcc or Subject line to show. */
  addressed: boolean
  /** The whole formatting strip - the six buttons, colour and links and lists
   *  among them - which only an email carries. */
  richText: boolean
  /** Which inline styles to offer where the whole strip does not apply. Empty
   *  is a channel that takes plain words and gets no strip at all; a channel
   *  that declared some gets exactly those buttons, because what it declared
   *  is also what the reply is wrapped in on the way out. */
  styles: readonly TextStyleName[]
  /** Whether a file can travel with it. */
  attachments: boolean
  /** Whether it can be forwarded to somebody else from here. */
  forward: boolean
}

/** One inline style, named the way core's ConversationTextStyles names it. */
export type TextStyleName = 'bold' | 'italic' | 'strikethrough' | 'monospace'

/** Email: the full box, which is what it has always been. */
export const EMAIL_REPLY_STYLE: ReplyStyle = {
  addressed: true,
  richText: true,
  styles: [],
  attachments: true,
  forward: true,
}

/**
 * A channel another module owns: words, back where they came from.
 *
 * All four are off together rather than one by one because they have one cause
 * between them - `sendProviderReply` takes a thread, a string and nothing else.
 * A channel that grows the ability to carry a photograph grows it in the seam
 * first, and this is where that would be said.
 */
export const CHANNEL_REPLY_STYLE: ReplyStyle = {
  addressed: false,
  richText: false,
  styles: [],
  attachments: false,
  forward: false,
}

/**
 * Which of the two a conversation gets, and what emphasis to offer on it.
 *
 * The provider module decides the first: a conversation with one is answered
 * through it, and one without is ours. The second comes from the channel itself
 * - `capabilities.textStyles`, declared by the module that owns it, which is
 * the only place that knows whether the far end has emphasis and how it writes
 * it. WhatsApp has bold, italic and strikethrough; a text message and a call
 * log have nothing, and get no buttons.
 *
 * Whatever comes back here is also what the words are wrapped in when they
 * leave (see lib/text-styles.ts), because both read the same declaration. That
 * is the whole reason a button offered here cannot be a button whose work is
 * quietly thrown away.
 */
export function replyStyleFor(
  thread: { providerModule: string | null },
  /** The channel's own declaration, straight off the resolved provider. */
  channelStyles?: Partial<Record<TextStyleName, string>> | null,
): ReplyStyle {
  if (!thread.providerModule) return EMAIL_REPLY_STYLE
  const styles = STYLE_NAMES.filter((name) => !!channelStyles?.[name])
  return styles.length === 0 ? CHANNEL_REPLY_STYLE : { ...CHANNEL_REPLY_STYLE, styles }
}

/** In the order the buttons are drawn in, so two channels declaring the same
 *  three do not draw them in two different orders. */
const STYLE_NAMES: readonly TextStyleName[] = ['bold', 'italic', 'strikethrough', 'monospace']

/**
 * Where a reply is going, in the words to print above the writing box.
 *
 * Shown in place of the To line, because something has to be: a box with no
 * addressing at all leaves somebody typing a reply with no statement anywhere
 * of who is about to receive it. Their name if we have one, otherwise the
 * number or address the conversation is keyed on, and the channel named either
 * way - "on WhatsApp" is the half that stops a reply being written as an email.
 */
export function replyDestination(input: {
  channelLabel: string
  /** What the conversation is keyed on at the far end - a number, usually. */
  party: string | null
  /** What they are called, when the channel told us. */
  name: string | null
}): string {
  const name = input.name?.trim()
  const party = input.party?.trim()
  const who = name || party
  if (!who) return `This goes back on ${input.channelLabel}.`
  // Both when we have both, since a name on its own is not something anybody
  // can check and a number on its own is not something anybody recognises.
  const said = name && party && name !== party ? `${name} (${party})` : who
  return `This goes back to ${said} on ${input.channelLabel}.`
}
