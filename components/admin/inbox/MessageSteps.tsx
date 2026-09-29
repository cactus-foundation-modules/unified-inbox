'use client'

import { AdminTooltip } from '@/components/admin/Tooltip'
import { pinnedHeader, scrollParent } from './pane-scroll'
import { ChevronDownIcon, ChevronUpIcon } from './icons'

// The two arrows between a message's date and its dots: the top of the one
// above, the top of the one below. A long conversation of newsletters and
// calls is a lot of wheel to get from one to the next, and an email's own
// signature and footer are rarely what anybody scrolled down for.
//
// The first message on the screen has no arrow up and the last has none down -
// an arrow that goes nowhere is a button that looks broken. Which ones those
// are is decided by whoever draws the list (ThreadPane), since that is the only
// thing that knows the order the messages are shown in.
//
// Landed under the glass header rather than behind it, the same way opening a
// conversation on its newest message does (ScrollToMessage).

type Props = {
  /** The `id` of the message above this one on the screen, if there is one. */
  previousId: string | null
  /** The `id` of the message below it, if there is one. */
  nextId: string | null
}

function scrollToMessage(id: string) {
  const target = document.getElementById(id)
  if (!target) return
  const wanted = target.getBoundingClientRect().top - pinnedHeader(target)
  const scroller = scrollParent(target)
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const behavior: ScrollBehavior = smooth ? 'smooth' : 'auto'
  if (scroller) scroller.scrollBy({ top: wanted - scroller.getBoundingClientRect().top, behavior })
  else window.scrollBy({ top: wanted, behavior })
}

export function MessageSteps({ previousId, nextId }: Props) {
  if (!previousId && !nextId) return null
  return (
    <span className="uin-msg-steps">
      {previousId && (
        <AdminTooltip body="Previous message">
          <button
            type="button"
            className="uin-icon-btn"
            aria-label="Go to the message above"
            onClick={() => scrollToMessage(previousId)}
          >
            {ChevronUpIcon}
          </button>
        </AdminTooltip>
      )}
      {nextId && (
        <AdminTooltip body="Next message">
          <button
            type="button"
            className="uin-icon-btn"
            aria-label="Go to the message below"
            onClick={() => scrollToMessage(nextId)}
          >
            {ChevronDownIcon}
          </button>
        </AdminTooltip>
      )}
    </span>
  )
}
