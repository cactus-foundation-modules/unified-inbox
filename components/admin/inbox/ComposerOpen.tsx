'use client'

import { useEffect, useRef } from 'react'
import { Composer } from './Composer'
import { useComposerOpen } from './composer-open'
import { alignToTop } from './pane-scroll'
import type { DraftForComposer } from '@/modules/unified-inbox/lib/drafts'
import { EMAIL_REPLY_STYLE, type ReplyStyle } from '@/modules/unified-inbox/lib/channel-reply'
import type { ProductChoice } from '@/modules/unified-inbox/lib/products/types'
import type { QuotedPreview } from '@/modules/unified-inbox/lib/quoted-preview'

// Where the writing box appears, once somebody has asked for one. Whether it is
// open at all lives in composer-open.tsx, which both this and the box itself
// read.
export { ComposerOpenProvider, useComposerOpen } from './composer-open'

type SlotProps = {
  threadId: string
  /** The address it would leave as, for the suggestions under To. */
  inboxId: string | null
  replyTo: string[]
  replyAllTo: string[]
  canReply: boolean
  canForward: boolean
  /** How this conversation is answered - see lib/channel-reply.ts. */
  style: ReplyStyle
  /** Messages that came in by mail on a conversation a channel owns; a reply
   *  to one of them gets the email box. */
  emailMessageIds: string[]
  /** The message a reply with none named answers. */
  newestIncomingId: string | null
  /** See ThreadPane. Not used here, passed through to be stripped. */
  alsoByEmail?: string | null
  /** Who the reply goes to, in words, where the conversation decides it. */
  destinationLine: string | null
  staff: Array<{ id: string; name: string }>
  cannotReplyReason: string | null
  /** What the subject would say if nobody opened the Subject line, worked out
   *  on the server exactly as the send route works it out. */
  replySubject: string
  forwardSubject: string
  draft: DraftForComposer | null
  /** Whether this person may put anything out of the catalogue on a message. */
  canAddProducts: boolean
  /** What the draft was carrying out of it, already looked up. */
  draftProducts: ProductChoice[]
  /** Every message on the conversation that a reply could quote, described
   *  well enough for the box to show the one it is quoting. */
  quotedPreviews: QuotedPreview[]
  /** Whether anything installed on this site can draft a reply. */
  canSuggestReplies: boolean
  timezone: string
}

/**
 * Where the box appears, once somebody has asked for it.
 *
 * Not rendered at all while it is shut, rather than hidden: the composer holds
 * a draft, a token and an unsaved-work guard, and none of that should be alive
 * on a conversation nobody is writing on.
 */
export function ComposerSlot(props: SlotProps) {
  const { opened } = useComposerOpen()
  const slot = useRef<HTMLDivElement | null>(null)

  // Pressing Reply on a message halfway up a long conversation opened the box
  // and left the reader where they were, looking at the message they had just
  // answered, with no sign anything had happened. So the pane comes to the box.
  //
  // To the TOP of the box, under the header, rather than merely far enough to
  // have it on the screen: `block: 'nearest'` stopped the moment the bottom
  // edge appeared, which left the message being answered filling most of the
  // pane and the box you had just asked for wedged along the bottom of it.
  //
  // `at` counts presses, so switching from Reply to Forward brings it back into
  // view as well. Not on the way in, though: a half-written draft opens the box
  // on arrival, and scrolling to it there would fight the pane's own opening
  // position - which is deliberately the newest message. Hence the first-run
  // guard rather than a plain effect.
  const at = opened?.at ?? null
  const mode = opened?.mode ?? null
  const opening = useRef(true)
  useEffect(() => {
    if (opening.current) { opening.current = false; return }
    if (at === null) return
    const box = slot.current
    if (!box) return
    alignToTop(box, true)
  }, [at, mode])

  if (!opened) return null
  const { emailMessageIds, newestIncomingId, alsoByEmail, ...rest } = props
  // The box follows the message being answered: an email in a chat is written
  // as an email, a chat message in the same conversation as a chat.
  const target = opened.messageId ?? props.draft?.inReplyToMessageId ?? newestIncomingId
  // A draft with a subject on it was written as an email (a channel takes
  // none), so it opens as one.
  const askedForEmail = opened.via === 'email'
    || (!!alsoByEmail && !!props.draft?.subject?.trim())
  const asEmail = askedForEmail || (target !== null && emailMessageIds.includes(target))
  return (
    <div id="uin-composer" ref={slot}>
      <Composer
        key={asEmail ? 'email' : 'channel'}
        {...rest}
        startWithSubject={askedForEmail}
        style={asEmail ? EMAIL_REPLY_STYLE : props.style}
        destinationLine={asEmail ? null : props.destinationLine}
        canForward={props.canForward || asEmail}
        requestedMode={opened.mode}
        requestedAt={opened.at}
        requestedReplyToId={opened.messageId}
      />
    </div>
  )
}
