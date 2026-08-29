import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { cleanSignatureHtml, renderInboxSignature } from '@/modules/unified-inbox/lib/signature'

// What a signature will actually look like at the foot of a reply, rendered by
// the same code that renders the one that gets sent.
//
// Takes the draft rather than an inbox id on purpose: somebody trying a
// signature out should not have to save it to the live inbox to find out that
// the logo is enormous. Nothing here writes anything.

const Body = z.object({
  kind: z.enum(['markdown', 'html', 'puck']),
  signature: z.string().max(5000).nullable(),
  signatureHtml: z.string().max(50000).nullable(),
  signaturePuck: z.unknown().nullable(),
  name: z.string().max(120).default(''),
  address: z.string().max(255).default(''),
  fromName: z.string().max(120).nullable().default(null),
})

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That signature does not look right.')
  const data = parsed.data

  const rendered = await renderInboxSignature({
    signatureKind: data.kind,
    signature: data.signature,
    // Cleaned here too, so the preview shows what saving would store rather
    // than what was typed - an author whose paste gets stripped should find
    // that out here rather than in a customer's inbox.
    signatureHtml: cleanSignatureHtml(data.signatureHtml),
    signaturePuck: data.signaturePuck ?? null,
    name: data.name,
    address: data.address,
    fromName: data.fromName,
  })

  return NextResponse.json(
    { html: rendered?.html ?? null },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
