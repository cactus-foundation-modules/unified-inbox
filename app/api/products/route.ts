import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { listDeliveries, listVariations, productFromUrl, searchProducts } from '@/modules/unified-inbox/lib/products'
import { PICKS_PATTERN } from '@/modules/unified-inbox/lib/products/slots'

// The catalogue, for putting something out of it on a message.
//
// Two questions and one route: what could I mean (a search, or a browse when
// nothing is typed), and what does this listing come in (its variations). A
// third rides along for the same reason - what can this one be delivered by,
// for quoting a delivery service beside it. They
// are the same gesture a keystroke apart, and splitting them across two
// addresses would only mean two lots of the same three permission checks.
//
// Gated on being allowed to answer the post AND, inside `searchProducts`, on
// being allowed to see the module's products. Both are needed: a list of what
// the site sells and what it charges is a thing worth having to be allowed to
// look at, and somebody who may read a shared inbox is not automatically
// somebody who may read the catalogue.

export async function GET(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.reply')) return errorResponse('Forbidden', 403)

  const params = request.nextUrl.searchParams
  const listing = params.get('of')
  const moduleName = params.get('module')

  // The delivery services one chosen thing can be bought with, for quoting one
  // beside it. The same reference a slot carries, checked the same way.
  const deliveryFor = params.get('deliveries')
  if (deliveryFor !== null) {
    const kind = params.get('kind')
    const picks = params.get('picks') ?? ''
    if (!moduleName) return errorResponse('Say which module the product belongs to.')
    if (kind !== 'product' && kind !== 'variation') return errorResponse('Say what kind of thing it is.')
    if (!deliveryFor || deliveryFor.length > 200) return errorResponse('Say which product.')
    if (picks && !PICKS_PATTERN.test(picks)) return errorResponse('Those options are not ones the shop sells.')
    const items = await listDeliveries(user, {
      moduleName, kind, id: deliveryFor, ...(picks ? { picks } : {}),
    })
    return NextResponse.json({ items }, { headers: { 'Cache-Control': 'no-store' } })
  }

  // The variations of one listing. Both halves are required: which module sells
  // it is not something to guess at, and guessing would mean asking every
  // source about an id that belongs to one of them.
  if (listing) {
    if (!moduleName) return errorResponse('Say which module the listing belongs to.')
    const items = await listVariations(user, moduleName, listing.slice(0, 200))
    return NextResponse.json({ items }, { headers: { 'Cache-Control': 'no-store' } })
  }

  // A pasted address: the one product it is the page of, or nothing. Too long
  // to be an address is not an address.
  const address = params.get('url')
  if (address !== null) {
    const item = address.length <= 2000 ? await productFromUrl(user, address) : null
    return NextResponse.json({ item }, { headers: { 'Cache-Control': 'no-store' } })
  }

  const term = (params.get('q') ?? '').slice(0, 100)
  const items = await searchProducts(user, term)
  return NextResponse.json({ items }, { headers: { 'Cache-Control': 'no-store' } })
}
