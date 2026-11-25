import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { RulePreviewBody, ruleProblem } from '@/modules/unified-inbox/lib/rules'
import { previewRule } from '@/modules/unified-inbox/lib/rules-engine'
import { requireRulesManager } from '@/modules/unified-inbox/lib/rules-route'

// "What would this rule have done lately?" - asked of a rule as it stands in
// the editor, saved or not. Reads only; nothing is changed.
//
// Shows subjects and senders from every mailbox on the site to the person
// asking, which is why it sits behind the same permission as writing rules:
// somebody who may set up the inbox may already see where its mail goes.

export const maxDuration = 60

export async function POST(request: NextRequest) {
  const guard = await requireRulesManager()
  if (!guard.ok) return guard.response
  const parsed = RulePreviewBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('Finish filling the rule in, then try it again.')
  const problem = ruleProblem(parsed.data.rule)
  if (problem) return errorResponse(problem)
  const result = await previewRule(parsed.data.rule, parsed.data.days)
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
}
