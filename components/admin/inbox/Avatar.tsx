'use client'

import { useState } from 'react'

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

export function Avatar({ src, children, badge, title }: Props) {
  const [failed, setFailed] = useState(false)
  return (
    <span className="uin-avatar-wrap">
      <span className="uin-avatar" title={title}>
        <span aria-hidden="true">{children}</span>
        {src && !failed && (
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
