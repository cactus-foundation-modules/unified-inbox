// What the writing box shows underneath the words, folded away.
//
// The quotation itself is built on the server when the message is actually sent
// (see quoteForReply and quoteForForward in compose.ts) - it has to be, because
// the markup that goes out is sanitised on its way out and never touches the
// admin page. So until now the box said nothing at all about what would appear
// beneath a reply, and the only way to find out what a customer would receive
// was to send it and read your own copy.
//
// This is the description of that quotation, small enough to hand to the
// browser with the conversation: which message it is, the line that introduces
// it, and enough to render the message itself the way the conversation above
// renders it - in a frame of its own for markup, as words for anything else.
//
// NOTHING IS IMPORTED HERE ON PURPOSE. The writing box is a client component
// and picks its preview with the function below; compose.ts reaches the
// sanitiser and the site's clock, and dragging those into the browser's graph
// is the leak that lib/modules' prebuild check exists to catch.

export type QuotedPreview = {
  id: string
  /** Milliseconds rather than a Date: a Date in props arrives at a client
   *  component as an empty object. */
  sentAtMs: number
  /** "On 3 March 2026 at 14:05, Jane Smith wrote:" - the line that goes above
   *  the quotation in a reply, built by the same function that writes it into
   *  the message. */
  attribution: string
  /** From / Date / Subject / To, as a forward reproduces them. Same rows the
   *  forwarded message carries, so the box is not describing something else. */
  forwardHeader: Array<[string, string]>
  /** Whether it has markup of its own, and so whether it is drawn in a frame. */
  hasHtml: boolean
  hasRemoteImages: boolean
  ownSender: boolean
  /** The words, for a message with no markup. Null for one that has some - its
   *  body is fetched into the frame rather than carried here. */
  bodyText: string | null
}

/**
 * Which message the box is quoting.
 *
 * The same rule the send route follows, so what is shown is what will be sent:
 * the message somebody pressed Reply on, and failing that the newest on the
 * conversation. Failing that too - a named message that has since been deleted,
 * or a conversation with nothing quotable on it at all - nothing, and the box
 * simply does not offer the panel rather than describing a quotation that is
 * not there.
 *
 * Notes are never in this list. One is written for colleagues on this screen
 * and is never quoted into anything that leaves.
 */
export function pickQuotedPreview(
  previews: QuotedPreview[],
  replyToId: string | null,
): QuotedPreview | null {
  if (replyToId) {
    const named = previews.find((preview) => preview.id === replyToId)
    if (named) return named
  }
  let newest: QuotedPreview | null = null
  for (const preview of previews) {
    if (!newest || preview.sentAtMs > newest.sentAtMs) newest = preview
  }
  return newest
}
