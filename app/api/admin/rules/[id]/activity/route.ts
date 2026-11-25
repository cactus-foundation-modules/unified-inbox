import { NextRequest, NextResponse } from 'next/server'
import { listRuleRuns } from '@/modules/unified-inbox/lib/rules-db'
import { requireRulesManager } from '@/modules/unified-inbox/lib/rules-route'

// What one rule has done lately, newest first, for the list under it.

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireRulesManager()
  if (!guard.ok) return guard.response
  const { id } = await params
  const runs = await listRuleRuns(id, 20)
  return NextResponse.json({ runs }, { headers: { 'Cache-Control': 'no-store' } })
}
