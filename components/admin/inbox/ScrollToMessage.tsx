'use client'

import { useEffect } from 'react'
import { pinnedHeader, scrollParent } from './pane-scroll'

// Opens a conversation on the message worth reading rather than at the top of
// it.
//
// Only ever used when the site reads oldest first: newest first puts the newest
// message at the top of the pane already, and there is nothing to do. Reading
// oldest first, the newest message is at the BOTTOM, and a conversation with
// forty messages in it opens four thousand pixels away from the one that has
// just arrived - so you scroll past every message you have already read to
// reach the only one you came for.
//
// Which message that is, is decided on the server: it knows whether the
// conversation was unread when it was opened, which is a thing that stops being
// true the moment it is. See InboxPanel.
//
// The awkward part is that a conversation does not know how tall it is when it
// is drawn. An email's own HTML is rendered in a frame of its own (E16) that
// reports its height back once it has loaded, and keeps reporting it as
// pictures arrive - so a thread of five emails settles at its real height a
// second or two after it appears, and everything below the messages that
// changed moves down. A single scroll on the way in lands wherever the guessed
// heights happened to put it, which on a thread of newsletters is nowhere near.
//
// So the position is corrected as the pane settles, and left alone the instant
// the reader touches it: being dragged back to where the page thinks you should
// be is far worse than opening in the wrong place.

/** How long to keep correcting the position. Long enough for a slow line to
 *  deliver a thread of large messages, short enough that it is over well before
 *  anybody could have read to the end of one. */
const SETTLE_MS = 6000

type Props = {
  /** The conversation this belongs to. Only here so that opening another one
   *  runs the whole thing again rather than inheriting the last one's work. */
  threadId: string
  /** The `id` attribute of the message to bring to the top of the pane. */
  targetId: string
}

export function ScrollToMessage({ threadId, targetId }: Props) {
  useEffect(() => {
    const target = document.getElementById(targetId)
    if (!target) return

    const scroller = scrollParent(target)
    let stopped = false

    const align = () => {
      if (stopped) return
      const wanted = target.getBoundingClientRect().top - pinnedHeader(target)
      if (scroller) scroller.scrollTop += wanted - scroller.getBoundingClientRect().top
      else window.scrollBy(0, wanted)
    }

    // Every height the frames report arrives as a resize of the run of
    // messages, which is the one box that changes when any message in it does.
    const observer = new ResizeObserver(align)
    const settling = target.closest('.uin-thread-body') ?? target.parentElement
    if (settling) observer.observe(settling)

    let timer = 0

    // Whoever is reading has the last word. Deliberately not the scroll event:
    // that is what align fires, and listening for it would stop the correction
    // on its own first attempt.
    const stop = () => {
      if (stopped) return
      stopped = true
      observer.disconnect()
      window.clearTimeout(timer)
      for (const event of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) {
        window.removeEventListener(event, stop)
      }
    }

    timer = window.setTimeout(stop, SETTLE_MS)
    for (const event of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) {
      window.addEventListener(event, stop, { passive: true })
    }

    align()
    return stop
  }, [threadId, targetId])

  return null
}
