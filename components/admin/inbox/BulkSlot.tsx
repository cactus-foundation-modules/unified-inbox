'use client'

import type { ReactNode } from 'react'
import { useSelection } from './Selection'

// ---------------------------------------------------------------------------
// The strip under the search box: the status tabs, until something is picked,
// and then the bar that acts on the pick.
//
// Two rows of controls stacked above one list was one row too many, and the tabs
// are no use while a pile is ticked - nobody switches from Open to Done with six
// conversations in their hand. So the tabs step aside and the bar takes their
// place. The bar itself is still drawn by the list, which owns the handlers it
// calls; it is carried into the slot below with a portal rather than moved here.
//
// The tabs are hidden rather than unmounted, so they are exactly as they were
// when the pick is cleared. `display: contents` while they show, so the wrapper
// adds no box of its own to the layout they were built for.
// ---------------------------------------------------------------------------

export const BULK_SLOT_ID = 'uin-bulk-slot'

export function TabsOrBulk({ children }: { children: ReactNode }) {
  const { picked } = useSelection()
  const selecting = picked.length > 0
  return (
    <>
      <div style={{ display: selecting ? 'none' : 'contents' }}>{children}</div>
      <div id={BULK_SLOT_ID} style={{ display: selecting ? 'block' : 'none' }} />
    </>
  )
}
