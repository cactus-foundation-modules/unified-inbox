'use client'

import { useState, useSyncExternalStore } from 'react'

// Somebody's own picture, over their initials.
//
// The initials are the thing that is actually drawn. The picture is laid over
// the top of them once it has loaded, and taken away again if it does not - so
// a row never shows a broken image, never jumps as pictures arrive, and looks
// exactly as it did before this existed on a site with the setting switched
// off or with customers who have never heard of Gravatar. Which is most of
// them: the route answers 404 far more often than it answers a picture, and
// that has to be the quiet case rather than the ugly one.
//
// `src` is a route on this site, not an address at Gravatar - see avatarHref in
// lib/list.ts for why that matters.

type Props = {
  /** Where the picture is, or null when there is nobody to look up: no person
   *  attached to the conversation, or the whole thing switched off. */
  src: string | null
  /** What stands in for it - initials, or an icon where there is no name to
   *  take initials from. */
  children: React.ReactNode
  /** The channel badge on the corner of the circle, where a row has one. */
  badge?: React.ReactNode
  /** Whose picture it is, for the little yellow box. Never the alt text: the
   *  circle is decoration and the row says the name in words beside it. */
  title?: string
}

/** Nothing ever changes, so nothing ever needs telling. */
const subscribeToNothing = () => () => {}

export function Avatar({ src, children, badge, title }: Props) {
  const [failed, setFailed] = useState(false)
  // The picture is asked for by the BROWSER rather than by the server, and the
  // difference is the whole of this fix. These circles are drawn on the server
  // like the rest of the conversation, so the <img> used to be in the markup
  // that arrived - which means the browser fetched it, got the 404 this route
  // answers most of the time, and drew its own broken-image glyph before React
  // had hydrated and hung the onError handler that takes it away again. The
  // handler then never fired, because the failure had already happened, and a
  // list of people who have never heard of Gravatar was a list of broken
  // pictures.
  //
  // So nothing is asked for until we are running in the browser, at which point
  // the handler is already on it and a miss goes back to initials the way it
  // always meant to. Costs nothing: these are lazy, decorative, and behind the
  // initials that were the real answer anyway.
  //
  // Asked the way React asks about anything outside itself, rather than with a
  // flag flipped in an effect: the server says no, the browser says yes, and
  // nothing subscribes to anything because the answer never changes again.
  const ready = useSyncExternalStore(subscribeToNothing, () => true, () => false)

  return (
    <span className="uin-avatar-wrap">
      <span className="uin-avatar" title={title}>
        <span aria-hidden="true">{children}</span>
        {src && ready && !failed && (
          // A plain img, not next/image: this is a route that answers 404 far
          // more often than it answers a picture, the bytes come from somebody
          // else's server, and the optimiser would be asked to fetch and cache
          // something that usually is not there.
          // eslint-disable-next-line @next/next/no-img-element -- see the note above
          <img
            className="uin-avatar-img"
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
          />
        )}
      </span>
      {badge}
    </span>
  )
}
