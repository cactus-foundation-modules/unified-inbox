// What a record attached to a conversation is called, and where it lives.
//
// Its own file because both halves of the screen need it and they are not the
// same kind of component: the rail on a person's page is rendered on the
// server, and the row under a conversation's actions is a client island with a
// menu in it. A shared function beats the same table written twice and drifting.

import type { RecordLink } from '@/modules/unified-inbox/lib/types'

/** What a kind of record is called in front of somebody who does not build
 *  websites. Only ever the fallback: an adapter that gives a link a label of
 *  its own is the better answer every time, because "Order SO-1042" says more
 *  than "Order". Same shape and the same reason as channelLabel in lib/list.ts,
 *  and here for the same reason: without it a stored link with no label put the
 *  raw kind on the screen, so somebody reading their own inbox was shown
 *  "purchase-order". */
const RECORD_TYPE_LABELS: Record<string, string> = {
  order: 'Order',
  'purchase-order': 'Purchase order',
  quote: 'Quote',
  product: 'Product',
  variation: 'Variation',
}

export function recordLabel(link: RecordLink): string {
  return link.label || RECORD_TYPE_LABELS[link.recordType] || 'Record'
}

/** Where a stored link points, under the admin root. The href is not stored -
 *  it is rebuilt from what the link holds, so a module that changes its own
 *  page addresses does not leave every conversation on the site pointing at a
 *  page that has moved. */
export function recordHref(link: RecordLink): string | null {
  if (link.moduleName === 'shop' && link.recordType === 'order') return `m/shop/orders/${link.recordId}`
  if (link.moduleName === 'purchase-orders' && link.recordType === 'purchase-order') {
    return `m/purchase-orders/orders/${link.recordId}`
  }
  if (link.moduleName === 'quote-for-shop' && link.recordType === 'quote') {
    return `m/quote-for-shop/quotes/${link.recordId}`
  }
  // A variation is a product row of the shop's own - a hidden child of the
  // listing it belongs to - so it opens in the same editor its parent does.
  // Nothing here needs to know how the two are joined, which is exactly as much
  // as this module is allowed to know about variations.
  if (link.moduleName === 'shop' && (link.recordType === 'product' || link.recordType === 'variation')) {
    return `m/shop/products/${link.recordId}`
  }
  return null
}
