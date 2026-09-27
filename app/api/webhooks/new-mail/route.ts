import { after, NextRequest, NextResponse } from 'next/server'
import {
  connectionByPushToken,
  getPushHookSecret,
  recordPushRing,
  savePushHookSecret,
} from '@/modules/unified-inbox/lib/db'
import { hookSignatureMatches, looksLikePushToken, PUSH_BUDGET_MS } from '@/modules/unified-inbox/lib/push-checks'
import { collectOnPush } from '@/modules/unified-inbox/lib/push-collect'

// ---------------------------------------------------------------------------
// Where a mail provider rings to say new mail has arrived. See
// lib/push-checks.ts for the whole arrangement.
//
// Built for Zoho Mail's outgoing webhooks, and works for anything that can POST
// to an address: the body is never read for mail, so a provider sending the
// whole email and one sending "something changed" are the same doorbell.
//
// Two locks on the door:
//   - the token in the address, which picks the mail account and is long and
//     random, as the Brevo route's is;
//   - Zoho's signature. Its first request carries an x-hook-secret header and
//     every request after carries x-hook-signature, a base64 HMAC-SHA256 of
//     the raw body under that secret. The secret is kept the moment it
//     arrives, and from then on a ring without a matching signature is
//     refused. A provider that never sends a secret is held to the token.
//
// Zoho saves the webhook only if the address answers 200 to that first
// request, and turns one off by itself if the address keeps failing to answer.
// So the answer goes straight back, and the mail is collected afterwards in
// the same function, inside the module dispatcher's 60 second ceiling.
// ---------------------------------------------------------------------------

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token') ?? ''
  const connection = looksLikePushToken(token) ? await connectionByPushToken(token) : null
  if (!connection) return NextResponse.json({ error: 'unauthorised' }, { status: 401 })

  const body = Buffer.from(await request.arrayBuffer())
  const offered = request.headers.get('x-hook-secret')?.trim()
  if (offered) {
    // Zoho's first request, when somebody saves the webhook - including saving
    // a fresh one after deleting the old, which comes with a fresh secret.
    await savePushHookSecret(connection.id, offered)
  } else {
    const secret = await getPushHookSecret(connection.id)
    if (secret && !hookSignatureMatches(secret, body, request.headers.get('x-hook-signature'))) {
      return NextResponse.json({ error: 'unauthorised' }, { status: 401 })
    }
  }

  const rang = await recordPushRing(connection.id)
  if (rang) {
    after(async () => {
      try {
        await collectOnPush(connection.id, rang, { budgetMs: PUSH_BUDGET_MS })
      } catch (err) {
        console.error('[unified-inbox] collecting after a new-mail ring failed', err)
      }
    })
  }

  return NextResponse.json({ ok: true })
}
