'use client'

import { useEffect } from 'react'

/**
 * The inbox does not zoom on a phone.
 *
 * A mail program is laid out to the width of the screen already, and the zoom
 * people met here was never one they asked for: iOS Safari zooms in on its own
 * the moment a field under 16px takes focus, and on a screen whose frame is
 * pinned to the viewport there is often nothing left to pinch against to get
 * back out again. So the page is held at its natural scale while the inbox is
 * on screen, and handed back exactly as it was the moment it is not.
 *
 * Done here, on the inbox's own screens, rather than in the site's viewport:
 * that setting is the whole site's, public pages included, and a shop visitor
 * squinting at a photo of a chair is entitled to pinch it.
 *
 * Three pieces, because no one of them covers every browser:
 * - maximum-scale=1 on the viewport tag, which is what stops the automatic
 *   zoom on focus (and pinch, on browsers that still honour it);
 * - gesturestart cancelled, which is the only thing iOS listens to for pinch
 *   since it stopped honouring user-scalable=no;
 * - touch-action in inbox.css on .uin-page, which tells everyone else the
 *   page pans but does not zoom.
 */
export function NoZoom() {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    const before = meta?.getAttribute('content') ?? null
    if (meta) {
      const kept = (before ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part && !/^(maximum-scale|minimum-scale|user-scalable)\s*=/i.test(part))
      meta.setAttribute('content', [...kept, 'maximum-scale=1', 'user-scalable=no'].join(', '))
    }

    const stop = (event: Event) => event.preventDefault()
    document.addEventListener('gesturestart', stop, { passive: false })
    document.addEventListener('gesturechange', stop, { passive: false })

    return () => {
      document.removeEventListener('gesturestart', stop)
      document.removeEventListener('gesturechange', stop)
      if (meta) {
        if (before === null) meta.removeAttribute('content')
        else meta.setAttribute('content', before)
      }
    }
  }, [])

  return null
}
