import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { listInboxes } from '@/modules/unified-inbox/lib/db'
import { getModuleSenderInboxId, setModuleSender } from '@/modules/unified-inbox/lib/module-senders'

// The one box another module's settings tab draws: which inbox that module's
// automatic emails leave as. Small on purpose - it answers about one module at
// a time, because that is how the panel is rendered, and a panel sitting on the
// shop's settings has no business being told what Purchase Orders does.
//
// Guarded by unifiedinbox.manage rather than by the host module's own
// permission: choosing which address the site sends as is a mail decision, and
// somebody who may not set up inboxes may not quietly repoint one either. The
// panel is only offered to people who hold it, so nobody meets a box that
// refuses them.

/** A module name as the manifest spells it. Nothing here checks it is
 *  installed - see setModuleSender for why a setting outlives an uninstall. */
const ModuleName = z.string().trim().regex(/^[a-z][a-z0-9-]*$/)

export async function GET(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const moduleName = ModuleName.safeParse(request.nextUrl.searchParams.get('module') ?? '')
  if (!moduleName.success) return errorResponse('Which module?')

  const [inboxes, inboxId] = await Promise.all([
    listInboxes(),
    getModuleSenderInboxId(moduleName.data),
  ])

  return NextResponse.json({
    // Only what a picker needs. The rest of an inbox - its folders, its
    // account, whether it holds a key - is the settings screen's business.
    inboxes: inboxes.map((inbox) => ({ id: inbox.id, name: inbox.name, address: inbox.address })),
    inboxId,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

const Body = z.object({
  module: ModuleName,
  /** Null is a real answer: "go back to the site's own address". */
  inboxId: z.string().min(1).nullable(),
})

export async function PUT(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That does not look right.')

  // An id that names no inbox would be refused by the foreign key anyway, but
  // as a 500 rather than a sentence - and the picker only ever offers real
  // ones, so anything else here is worth saying plainly.
  if (parsed.data.inboxId) {
    const inboxes = await listInboxes()
    if (!inboxes.some((inbox) => inbox.id === parsed.data.inboxId)) {
      return errorResponse('That inbox is no longer here. Pick another one.')
    }
  }

  await setModuleSender(parsed.data.module, parsed.data.inboxId)
  return NextResponse.json({ inboxId: parsed.data.inboxId })
}
