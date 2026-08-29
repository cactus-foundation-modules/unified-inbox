import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { canOpenThread } from '@/modules/unified-inbox/lib/access'
import { getThreadDetail, recordEvent, recordLink, threadHasLink } from '@/modules/unified-inbox/lib/db'
import { confirmReference, suggestRecords } from '@/modules/unified-inbox/lib/adapters'
import { buildContextQuery } from '@/modules/unified-inbox/lib/identity'
import type { LinkKind } from '@/modules/unified-inbox/lib/linking'

// Attaching a record to a conversation by hand.
//
// Somebody types the reference and the owning module is asked whether it holds
// one - the same confirmation the automatic linker uses, so a typo comes back
// as "nothing here has that number" rather than as a link to nothing. A link
// added this way is marked `user`, which is what stops the linker second
// guessing it later.

const Body = z.object({
  kind: z.enum(['order', 'po', 'quote']),
  reference: z.string().trim().min(1).max(60),
})

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.reply')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const thread = await getThreadDetail(id)
  if (!thread) return errorResponse('That conversation is no longer here.', 404)
  if (!await canOpenThread(user, thread)) return errorResponse('Forbidden', 403)

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('Type the reference you want to attach.')

  const kind = parsed.data.kind as LinkKind
  const target = await confirmReference(kind, parsed.data.reference)
  if (!target) {
    return errorResponse(`Nothing on this site has the reference ${parsed.data.reference}.`, 404)
  }
  if (await threadHasLink(id, target.moduleName, target.recordType, target.recordId)) {
    return NextResponse.json({ ok: true, message: 'That is already attached.' })
  }

  await recordLink({
    threadId: id,
    personId: null,
    moduleName: target.moduleName,
    recordType: target.recordType,
    recordId: target.recordId,
    label: target.label,
    confidence: 100,
    linkedBy: 'user',
  })
  await recordEvent(id, user.id, 'linked', { label: target.label, moduleName: target.moduleName })

  return NextResponse.json({ ok: true, label: target.label })
}

/**
 * The records somebody could mean, for picking one off a list.
 *
 * Typing a number in full is fine when you have the number in front of you and
 * a fair way from fine when the supplier's email says "the desks" and the order
 * is one of six open with them. Nothing typed is a browse rather than an empty
 * answer, and whoever is on the other end of the conversation decides what
 * comes first in it.
 *
 * Gated on the same permission as attaching, because a list of the site's
 * orders is a thing worth having to be allowed to see, and each source is
 * gated again on its own module's permission inside `suggestRecords`.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.reply')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const thread = await getThreadDetail(id)
  if (!thread) return errorResponse('That conversation is no longer here.', 404)
  if (!await canOpenThread(user, thread)) return errorResponse('Forbidden', 403)

  const kind = request.nextUrl.searchParams.get('kind')
  if (kind !== 'order' && kind !== 'po' && kind !== 'quote') {
    return errorResponse('Say what kind of record you are after.')
  }
  const term = (request.nextUrl.searchParams.get('q') ?? '').slice(0, 60)

  const query = thread.personId ? await buildContextQuery(thread.personId) : null
  const records = await suggestRecords(user, kind, term, query)

  return NextResponse.json(
    {
      records: records.map((r) => ({
        reference: r.reference,
        label: r.label,
        detail: r.detail,
        status: r.status,
      })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
