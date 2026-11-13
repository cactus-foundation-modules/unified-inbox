'use client'

import { useEffect } from 'react'

const NO_ZOOM = ['maximum-scale=1']

/** The viewport tag's content with maximum-scale=1 in it, or null when it is
 *  already there and nothing needs writing. */
function withNoZoom(content: string): string | null {
  const parts = content.split(',').map((part) => part.trim()).filter(Boolean)
  if (parts.some((part) => /^maximum-scale\s*=\s*1(\.0+)?$/i.test(part))) return null
  const kept = parts.filter((part) => !/^(maximum-scale|user-scalable)\s*=/i.test(part))
  return [...kept, ...NO_ZOOM].join(', ')
}

/**
 * The inbox does not zoom in on its own on a phone.
 *
 * iOS zooms the whole page in when a box under 16px takes focus - the search,
 * a reply - and on a screen whose frame is pinned to the window there is little
 * left to pinch against on the way back out. maximum-scale=1 on the viewport
 * tag is what stops that automatic zoom. A newer core's HQ layout says so itself
 * as well, and its stylesheet lifts every box to 16px on a touch screen; this
 * is the same thing for a site whose core predates that, and harmless on one
 * that already does.
 *
 * It keeps saying so. Next re-renders the head's viewport tag on a refresh and
 * a navigation, which quietly put the old content back and let the zoom return
 * - so the tag is watched and corrected whenever it loses the setting.
 *
 * Deliberately NOT a block on pinching. An earlier version cancelled iOS's
 * pinch gesture and set touch-action against it, and that turned a zoom that
 * slipped through into a zoom nobody could get out of. iOS lets a person pinch
 * whatever the tag says, and that is the way out, so it is left alone.
 *
 * Handed back exactly as it was when the inbox goes, because the tag is the
 * whole site's.
 */
export function NoZoom() {
  useEffect(() => {
    const current = () => document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    const first = current()
    const before = first?.getAttribute('content') ?? null

    const apply = () => {
      const meta = current()
      if (!meta) return
      const next = withNoZoom(meta.getAttribute('content') ?? '')
      if (next !== null) meta.setAttribute('content', next)
    }
    apply()

    // The whole head rather than the one tag, because a re-render may swap the
    // element for a new one rather than rewrite the old one. Only writes when
    // the setting has gone, so its own write is a no-op the next time round
    // rather than a loop.
    const watch = new MutationObserver(apply)
    watch.observe(document.head, { subtree: true, childList: true, attributes: true, attributeFilter: ['content'] })

    return () => {
      watch.disconnect()
      const meta = current()
      if (!meta || before === null) return
      meta.setAttribute('content', before)
    }
  }, [])

  return null
}
