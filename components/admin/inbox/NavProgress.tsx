'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLinkStatus } from 'next/link'

// "Yes, that press landed."
//
// Every screen in this hub is drawn on the server and reached by an ordinary
// link: which conversation is open, which folder, which tab, whether the
// compose box is up. That is the right design - the address describes the
// screen, so a bookmark and the back button both work - but it has one cost
// nothing else on the site has. A press does not change anything until the
// server has answered, and until then the screen sits exactly as it was.
//
// Which looks identical to a press that missed. People pressed again. Then they
// pressed a third time, on a different conversation, and the one that finally
// arrived was not the one they last asked for.
//
// So: a hairline across the top of the frame, from the moment something is
// pressed until the screen it asked for is on the page. It says nothing about
// how long is left, because nothing here knows - it says only that the site
// heard, which is the whole of what was missing.
//
// HOW IT KNOWS IT IS OVER. Not a timer, and not the address bar: the address
// changes the instant the navigation starts, so anything watching it would call
// the job done at the moment it began. It watches `routeKey`, which the SERVER
// builds out of the address it actually drew. A new one of those in the props
// means the new screen is here - the only honest signal there is, and it cannot
// run ahead of the thing it reports on.

type Props = {
  /** What the server drew, as one string. Changes exactly when a navigation
   *  has landed, which is what ends the bar. */
  routeKey: string
}

/** A press that was never going to redraw this screen: a new tab, a download, a
 *  link out of the admin, an anchor on the page we are already on. None of them
 *  leaves anybody waiting, and a bar for them is a bar that cries wolf. */
function willRedraw(event: MouseEvent, anchor: HTMLAnchorElement): boolean {
  if (event.defaultPrevented) return false
  if (event.button !== 0) return false
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false
  if (anchor.target && anchor.target !== '_self') return false
  if (anchor.hasAttribute('download')) return false
  const href = anchor.getAttribute('href')
  if (!href || href.startsWith('#')) return false
  // Same site only. An external link takes the whole window and this frame goes
  // with it, so there is nothing here to report on.
  if (anchor.origin !== window.location.origin) return false
  // And not a link to precisely where we already are, which redraws nothing.
  return anchor.href !== window.location.href
}

export function NavProgress({ routeKey }: Props) {
  // Which screen was on the page when something was pressed. Held rather than a
  // plain boolean, and compared in the render rather than cleared by an effect,
  // so the bar cannot outlive the navigation that started it: the moment the
  // server sends a different routeKey this stops matching and the bar goes.
  const [waitingFrom, setWaitingFrom] = useState<string | null>(null)
  const waiting = waitingFrom !== null && waitingFrom === routeKey

  // A navigation can also be refused after the fact - an unsaved-changes
  // question that ends in Cancel, a link the router declines to follow. Nothing
  // tells us that happened, so the bar gives up on its own after a while rather
  // than sitting there for ever implying the site is still thinking.
  const giveUp = useRef<number | null>(null)
  const stopWaiting = useCallback(() => {
    if (giveUp.current !== null) window.clearTimeout(giveUp.current)
    giveUp.current = null
    setWaitingFrom(null)
  }, [])

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest('a')
      if (!anchor || !willRedraw(event, anchor)) return
      // Capture phase, so this runs BEFORE the router's own handler and before
      // anything on the page that might call preventDefault later. A press that
      // is cancelled afterwards is covered by the timeout above; a press missed
      // because somebody else got to the event first is not covered by
      // anything, which is why this is the earlier of the two.
      setWaitingFrom(routeKey)
      if (giveUp.current !== null) window.clearTimeout(giveUp.current)
      giveUp.current = window.setTimeout(() => setWaitingFrom(null), 15_000)
    }
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('click', onClick, true)
      if (giveUp.current !== null) window.clearTimeout(giveUp.current)
    }
  }, [routeKey])

  // Somebody who has gone Back has not pressed anything and is not waiting on
  // us; the bar from whatever they pressed before should not still be up.
  useEffect(() => {
    window.addEventListener('pageshow', stopWaiting)
    return () => window.removeEventListener('pageshow', stopWaiting)
  }, [stopWaiting])

  return (
    <div
      className="uin-navbar"
      data-waiting={waiting ? 'true' : undefined}
      // Announced rather than drawn only, because somebody on a screen reader
      // has even less to go on than somebody watching: no cursor change, no
      // half-drawn page, nothing at all until the new screen reads itself out.
      role="status"
      aria-live="polite"
    >
      <span className="uin-navbar-fill" aria-hidden="true" />
      <span className="sr-only">{waiting ? 'Loading' : ''}</span>
    </div>
  )
}


// The same message as the bar above, said on the control that was actually
// pressed rather than at the top of the frame.
//
// Both are worth having and they answer different questions. The bar says the
// site is working; this says WHICH of the things on the screen it is working
// on, which matters on a rail where half a dozen links sit under each other and
// somebody who pressed one of them cannot tell the bar apart from a colleague's
// mail arriving.
//
// Rendered as a CHILD of the Link it reports on - that is how useLinkStatus
// finds out which navigation it belongs to - so a control that wants one drops
// it inside and needs to know nothing else. It draws nothing at all until that
// particular link is the one being waited on, so it is free to put on
// everything and there is no list to keep in step.
export function LinkBusy() {
  const { pending } = useLinkStatus()
  if (!pending) return null
  return <span className="uin-link-busy" aria-hidden="true" />
}
