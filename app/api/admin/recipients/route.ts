import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { visibleInboxIds } from '@/modules/unified-inbox/lib/access'
import { listInboxes, recentRecipients } from '@/modules/unified-inbox/lib/db'

// Who this inbox has been talking to, for the To and Cc boxes on a new message.
//
// Read-only, and bounded twice: by the inboxes this person may read, and by the
// inbox they are actually writing from. An address suggestion is a fragment of
// somebody's correspondence - who a colleague deals with, and how recently - so
// the suggestion list may never reach past what its reader could already open
// by hand.
//
// Answers between keystrokes, so it stays a single indexed query with a small
// limit and no people-directory search behind it.

const Query = z.object({
  inbox: z.string().trim().min(1).max(64).nullish(),
  q: z.string().trim().max(120).nullish(),
  limit: z.coerce.number().int().min(1).max(25).nullish(),
})

export async function GET(request: Request) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)

  const url = new URL(request.url)
  const parsed = Query.safeParse({
    inbox: url.searchParams.get('inbox'),
    q: url.searchParams.get('q'),
    limit: url.searchParams.get('limit') ?? undefined,
  })
  if (!parsed.success) return errorResponse('That request did not make sense.', 400)

  const inboxes = await listInboxes()
  const visible = await visibleInboxIds(user, inboxes.map((i) => i.id))
  if (visible.length === 0) return NextResponse.json({ suggestions: [] })

  const suggestions = await recentRecipients({
    inboxId: parsed.data.inbox ?? null,
    visibleInboxIds: visible,
    search: parsed.data.q ?? null,
    limit: parsed.data.limit ?? 8,
  })

  return NextResponse.json({
    suggestions: suggestions.map((s) => ({
      address: s.address,
      name: s.name,
      organisation: s.organisation,
      lastAt: s.lastAt.toISOString(),
    })),
  })
}
