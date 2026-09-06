'use client'

import { useEffect, useRef, useState } from 'react'
import { AdminTooltip } from '@/components/admin/Tooltip'

// The address in a message header, cut short when there is no room for it.
//
// The header is one line - the sender, where the message came from or went to,
// the time, and the arrow and dots that answer it. Narrow the conversation
// column and the longest thing in that line is always the address, so the line
// used to wrap and the arrow and the dots dropped onto a second row of their
// own, away from the message they belong to.
//
// So the address gives way instead: it shrinks, and ends in an ellipsis. Which
// leaves the rest of the address unreadable, hence the tooltip - but only when
// there is something hidden to show. A tooltip that repeats what is already on
// screen is noise, so it is disabled while the whole address fits, which is
// the usual case at a normal width.
//
// The measurement is the ordinary one - the text is wider than the box holding
// it - taken again whenever the box changes size, because the column is
// draggable and the window is resizable.

export function AddressLine({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement | null>(null)
  const [clipped, setClipped] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // A pixel of slack: sub-pixel text metrics make scrollWidth report a
    // fraction more than clientWidth on text that is plainly not cut off.
    const measure = () => setClipped(el.scrollWidth > el.clientWidth + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text])

  return (
    <AdminTooltip body={text} disabled={!clipped} className="uin-msg-address">
      <span ref={ref} className="uin-msg-address-text">{text}</span>
    </AdminTooltip>
  )
}
