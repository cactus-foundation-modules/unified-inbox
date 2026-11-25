import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { RuleOrderBody } from '@/modules/unified-inbox/lib/rules'
import { reorderRules } from '@/modules/unified-inbox/lib/rules-db'
import { requireRulesManager } from '@/modules/unified-inbox/lib/rules-route'

// The order rules run in, top first - which matters once one of them says
// "stop here".

export async function POST(request: NextRequest) {
  const guard = await requireRulesManager()
  if (!guard.ok) return guard.response
  const parsed = RuleOrderBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That order did not make sense.')
  await reorderRules([...new Set(parsed.data.ids)])
  return NextResponse.json({ ok: true })
}
