import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { listInboxes } from '@/modules/unified-inbox/lib/db'
import {
  getModuleMailSettings,
  setModuleCopyInbox,
  setModuleSender,
} from '@/modules/unified-inbox/lib/module-senders'

// The box another module's settings tab draws: which inbox that module's
// automatic emails leave as, and which inbox a copy of them is filed in. Small
// on purpose - it answers about one module at a time, because that is how the
// panel is rendered, and a panel sitting on the shop's settings has no business
// being told what Purchase Orders does.
//
// Two settings rather than one since migration 046. A PUT may carry either, or
// both; a key left out is left alone, which is what lets the panel save one
// dropdown the moment it changes without knowing or resending the other.
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

  const [inboxes, settings] = await Promise.all([
    listInboxes(),
    getModuleMailSettings(moduleName.data),
  ])

  return NextResponse.json({
    // Only what a picker needs. The rest of an inbox - its folders, its
    // account, whether it holds a key - is the settings screen's business.
    inboxes: inboxes.map((inbox) => ({ id: inbox.id, name: inbox.name, address: inbox.address })),
    inboxId: settings.inboxId,
    copyInboxId: settings.copyInboxId,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

/** Null is a real answer on either field - "go back to the site's own address",
 *  "stop keeping copies" - and is the reason both are nullable AND optional:
 *  absent means "do not touch this one", which is not the same thing at all. */
const Body = z.object({
  module: ModuleName,
  inboxId: z.string().min(1).nullable().optional(),
  copyInboxId: z.string().min(1).nullable().optional(),
}).refine(
  (body) => body.inboxId !== undefined || body.copyInboxId !== undefined,
  { message: 'Nothing to change.' },
)

export async function PUT(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That does not look right.')
  const { module: moduleName, inboxId, copyInboxId } = parsed.data

  // An id that names no inbox would be refused by the foreign key anyway, but
  // as a 500 rather than a sentence - and the picker only ever offers real
  // ones, so anything else here is worth saying plainly.
  const wanted = [inboxId, copyInboxId].filter((id): id is string => !!id)
  if (wanted.length > 0) {
    const inboxes = await listInboxes()
    if (wanted.some((id) => !inboxes.some((inbox) => inbox.id === id))) {
      return errorResponse('That inbox is no longer here. Pick another one.')
    }
  }

  // One at a time, and in this order, because both write the same row: sending
  // first so that a request carrying both ends with the filing choice on top of
  // a row that already exists rather than racing it into being.
  if (inboxId !== undefined) await setModuleSender(moduleName, inboxId)
  if (copyInboxId !== undefined) await setModuleCopyInbox(moduleName, copyInboxId)

  // What the row actually says now, rather than what was asked for - the two
  // differ when a write lands on a row somebody else has just changed.
  return NextResponse.json(await getModuleMailSettings(moduleName))
}
