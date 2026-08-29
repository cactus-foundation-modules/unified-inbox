import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { isEncryptionKeyUsable } from '@/lib/crypto/secrets'
import { createConnection, listConnections } from '@/modules/unified-inbox/lib/db'

export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)
  return NextResponse.json({ connections: await listConnections() }, { headers: { 'Cache-Control': 'no-store' } })
}

const Body = z.object({
  label: z.string().min(1).max(120),
  imapHost: z.string().min(1).max(255),
  imapPort: z.number().int().min(1).max(65535).default(993),
  imapUsername: z.string().min(1).max(255),
  imapPassword: z.string().min(1),
  imapTls: z.boolean().default(true),
  extraFolders: z.array(z.string().min(1)).default([]),
  foldersOnly: z.boolean().default(false),
  discardUnrouted: z.boolean().default(false),
})

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)
  if (!isEncryptionKeyUsable()) {
    return errorResponse('This site has no encryption key set, so a mailbox password cannot be stored safely yet.')
  }

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('Those mail account details do not look right.')

  return NextResponse.json({ connection: await createConnection(parsed.data) }, { status: 201 })
}
