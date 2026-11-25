import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { RuleBody, RulePatchBody } from '@/modules/unified-inbox/lib/rules'
import { deleteRule, setRuleEnabled, updateRule } from '@/modules/unified-inbox/lib/rules-db'
import { requireRulesManager, ruleProblemWithData } from '@/modules/unified-inbox/lib/rules-route'

// One rule: saved over, switched on or off, or deleted.

type Params = { params: Promise<{ id: string }> }

export async function PUT(request: NextRequest, { params }: Params) {
  const guard = await requireRulesManager()
  if (!guard.ok) return guard.response
  const { id } = await params

  const parsed = RuleBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('Something in that rule is not filled in. Every condition needs a value and every step needs its details.')
  const problem = await ruleProblemWithData(parsed.data)
  if (problem) return errorResponse(problem)

  const rule = await updateRule(id, parsed.data, guard.userId)
  if (!rule) return errorResponse('That rule is not there any more.', 404)
  return NextResponse.json({ rule })
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const guard = await requireRulesManager()
  if (!guard.ok) return guard.response
  const { id } = await params

  const parsed = RulePatchBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success || parsed.data.enabled === undefined) return errorResponse('Nothing to change.')
  if (!await setRuleEnabled(id, parsed.data.enabled, guard.userId)) {
    return errorResponse('That rule is not there any more.', 404)
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const guard = await requireRulesManager()
  if (!guard.ok) return guard.response
  const { id } = await params
  // Deleting a rule leaves alone everything it already did - a merge it made
  // stays merged, and can still be put back from the conversation.
  if (!await deleteRule(id)) return errorResponse('That rule is not there any more.', 404)
  return NextResponse.json({ ok: true })
}
