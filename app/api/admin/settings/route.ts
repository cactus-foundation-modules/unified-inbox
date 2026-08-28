import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { prisma } from '@/lib/db/prisma'
import { isEncryptionKeyUsable } from '@/lib/crypto/secrets'
import {
  collectionStats,
  getSettings,
  peopleCount,
  listAllInboxAccess,
  listConnections,
  listInboxes,
  unroutedCount,
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

  const [connections, inboxes, access, settings, collection, unrouted, people, users] = await Promise.all([
    listConnections(),
    listInboxes(),
    listAllInboxAccess(),
    getSettings(),
    collectionStats(),
    unroutedCount(),
    peopleCount(),
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
    // How collection is getting on, per mail account: how much has been
    // gathered, roughly how much there is, and whether the older mail is still
    // being worked through in the background.
    collection,
    // Mail that reached the account but matched no inbox and had no catch-all
    // to fall into. Silence here means a whole address goes unread.
    unrouted,
    // How many people the hub has worked out so far, and what it currently
    // treats as one of the site's own domains - so the exclusion rule can be
    // checked rather than guessed at.
    people,
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

/** A regular expression typed into a box is user input, and one that will not
 *  compile must be refused here rather than discovered halfway through
 *  collecting the morning's mail. An empty string is a deliberate "do not link
 *  this kind" and is allowed. */
const Pattern = z.string().max(400).nullable().optional().refine(
  (value) => {
    if (!value) return true
    try { new RegExp(value); return true } catch { return false }
  },
  { message: 'That pattern is not valid.' },
)

const Domains = z.array(z.string().trim().toLowerCase().max(255)).max(100)

const Body = z.object({
  backfillMonths: z.number().int().min(1).max(240).optional(),
  retentionMonths: z.number().int().min(1).max(240).nullable().optional(),
  attachmentFetch: z.enum(['lazy', 'always', 'never']).optional(),
  autoLink: z.boolean().optional(),
  defaultInboxId: z.string().nullable().optional(),
  // NULL means "work the domains out from the addresses you collect mail on".
  // An empty array is a different answer and is kept as one.
  ownDomains: Domains.nullable().optional(),
  personalDomains: Domains.optional(),
  orderNumberPattern: Pattern,
  poNumberPattern: Pattern,
  quoteNumberPattern: Pattern,
})

export async function PATCH(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return errorResponse(first?.message === 'That pattern is not valid.'
      ? 'One of those reference patterns is not valid. Leave it empty to use the usual one.'
      : 'Those settings do not look right.')
  }

  const settings = await updateSettings(parsed.data)
  return NextResponse.json({ settings })
}
