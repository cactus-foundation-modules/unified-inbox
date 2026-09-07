import type { ProductRef } from '@/modules/unified-inbox/lib/products'
import { productPageUrls } from '@/modules/unified-inbox/lib/products'
import type { RecordLink } from '@/modules/unified-inbox/lib/types'

// The public address of the records attached to a conversation, worked out on
// the server so the screen can hand it to recordDestination in ./record-links.
//
// Its own file and not part of record-links.ts, which is imported by a client
// island: a function that reads the database has no business being reachable
// from the browser bundle, and one import is all it would take.
//
// Only products have a public address at all. An order, a purchase order and a
// quote are records of ours and open where they live, in the admin; a product
// is the one attached record the customer can see, and it was attached because
// somebody quoted it to them - so the page that opens is the page they were
// sent, not the editor behind it.

/** Keyed by the link's own id, so the screen looks it up with what it already
 *  has in its hand. Anything with no public page is simply absent. */
export async function publicRecordUrls(
  links: readonly RecordLink[],
): Promise<Record<string, string>> {
  const refs: ProductRef[] = []
  for (const link of links) {
    if (link.recordType !== 'product' && link.recordType !== 'variation') continue
    refs.push({ moduleName: link.moduleName, kind: link.recordType, id: link.recordId })
  }
  if (refs.length === 0) return {}

  const urls = await productPageUrls(refs)
  const out: Record<string, string> = {}
  for (const link of links) {
    const url = urls.get(`${link.moduleName}:${link.recordType}:${link.recordId}`)
    if (url) out[link.id] = url
  }
  return out
}
