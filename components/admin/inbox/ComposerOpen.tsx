'use client'

import { useEffect, useRef } from 'react'
import { Composer } from './Composer'
import { useComposerOpen } from './composer-open'
import { alignToTop } from './pane-scroll'
import type { DraftForComposer } from '@/modules/unified-inbox/lib/drafts'
import type { ProductChoice } from '@/modules/unified-inbox/lib/products/types'

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
  return (
    <div id="uin-composer" ref={slot}>
      <Composer {...props} requestedMode={opened.mode} requestedAt={opened.at} />
    </div>
  )
}
