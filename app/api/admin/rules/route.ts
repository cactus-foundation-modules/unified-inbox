import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { MAX_RULES, RuleBody } from '@/modules/unified-inbox/lib/rules'
import { countRules, createRule, listRules } from '@/modules/unified-inbox/lib/rules-db'
import { requireRulesManager, ruleProblemWithData } from '@/modules/unified-inbox/lib/rules-route'

// The Rules tab: every rule, and a new one. See lib/rules.ts.

export async function GET() {
  const guard = await requireRulesManager()
  if (!guard.ok) return guard.response
  const rules = await listRules()
  return NextResponse.json({ rules }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: NextRequest) {
  const guard = await requireRulesManager()
  if (!guard.ok) return guard.response

  const parsed = RuleBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('Something in that rule is not filled in. Every condition needs a value and every step needs its details.')

  if (await countRules() >= MAX_RULES) {
    return errorResponse(`That is ${MAX_RULES} rules already. Tidy a few away before adding another.`)
  }
  const problem = await ruleProblemWithData(parsed.data)
  if (problem) return errorResponse(problem)

  const rule = await createRule(parsed.data, guard.userId)
  return NextResponse.json({ rule }, { status: 201 })
}
