import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { prisma } from '@/lib/db/prisma'
import { isEncryptionKeyUsable } from '@/lib/crypto/secrets'
import {
  getSettings,
  listAllInboxAccess,
  listConnections,
  listInboxes,
  updateSettings,
} from '@/modules/unified-inbox/lib/db'

// Everything the settings screen draws, in one request: the mail accounts, the
// inboxes hanging off them, who may read which, the module's own settings, and
// the staff list the access editor picks from. Secrets are already booleans by
// the time they leave lib/db.ts.

export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const [connections, inboxes, access, settings, users] = await Promise.all([
    listConnections(),
    listInboxes(),
    listAllInboxAccess(),
    getSettings(),
    prisma.user.findMany({
      where: { suspendedAt: null },
      select: { id: true, displayName: true, username: true, email: true },
      orderBy: { username: 'asc' },
    }),
  ])

  return NextResponse.json({
    connections,
    inboxes,
    access,
    settings,
    users: users.map((u) => ({
      id: u.id,
      name: u.displayName || u.username,
      email: u.email,
    })),
    // Without a site encryption key there is nowhere safe to put a mailbox
    // password, so the screen says so rather than saving one in the clear.
    encryptionReady: isEncryptionKeyUsable(),
  }, { headers: { 'Cache-Control': 'no-store' } })
}

const Body = z.object({
  backfillMonths: z.number().int().min(1).max(240).optional(),
  retentionMonths: z.number().int().min(1).max(240).nullable().optional(),
  attachmentFetch: z.enum(['lazy', 'always', 'never']).optional(),
  autoLink: z.boolean().optional(),
  defaultInboxId: z.string().nullable().optional(),
})

export async function PATCH(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('Those settings do not look right.')

  const settings = await updateSettings(parsed.data)
  return NextResponse.json({ settings })
}
