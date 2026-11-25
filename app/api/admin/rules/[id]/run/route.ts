import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { RuleBackfillBody } from '@/modules/unified-inbox/lib/rules'
import { backfillRule } from '@/modules/unified-inbox/lib/rules-engine'
import { requireRulesManager } from '@/modules/unified-inbox/lib/rules-route'

// "Run on recent mail": one saved rule over the last few days or weeks of
// post, a slice per request, oldest first. The screen keeps asking with the
// cursor it is handed until the answer says done. Messages the rule has
// already run on are stepped over, so pressing it twice is harmless.

export const maxDuration = 60

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireRulesManager()
  if (!guard.ok) return guard.response
  const { id } = await params
  const parsed = RuleBackfillBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('Pick how far back to go.')
  const result = await backfillRule(id, parsed.data.days, parsed.data.after ?? null)
  if ('error' in result) return errorResponse(result.error)
  return NextResponse.json(result)
}
