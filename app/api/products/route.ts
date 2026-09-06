import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { listVariations, searchProducts } from '@/modules/unified-inbox/lib/products'

// The catalogue, for putting something out of it on a message.
//
// Two questions and one route: what could I mean (a search, or a browse when
// nothing is typed), and what does this listing come in (its variations). They
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

  // The variations of one listing. Both halves are required: which module sells
  // it is not something to guess at, and guessing would mean asking every
  // source about an id that belongs to one of them.
  if (listing) {
    if (!moduleName) return errorResponse('Say which module the listing belongs to.')
    const items = await listVariations(user, moduleName, listing.slice(0, 200))
    return NextResponse.json({ items }, { headers: { 'Cache-Control': 'no-store' } })
  }

  const term = (params.get('q') ?? '').slice(0, 100)
  const items = await searchProducts(user, term)
  return NextResponse.json({ items }, { headers: { 'Cache-Control': 'no-store' } })
}
