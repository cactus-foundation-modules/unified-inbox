import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getActiveSmsProvider } from '@/lib/auth/sms'
import { normaliseSmsNumber } from '@/lib/sms/send'
import { SmsBody } from '@/modules/unified-inbox/lib/validation'

// Sending a text from the inbox.
//
// It goes out through core's SMS seam (lib/auth/sms.ts), which is whichever
// module the site has given a number to. This module names none of them and
// holds no telephony credentials, exactly as it holds none for live chat.
//
// NOTHING IS WRITTEN DOWN HERE, and that is deliberate rather than an omission.
// A site that can send a text has a module that owns texts, and that module
// publishes its conversations back to this hub through
// `core.conversation-provider` - so the text appears in the phone conversation
// with that number, alongside the calls, filed by the part of the site that
// actually knows what happened to it. Writing our own copy as well would put
// the same message on the screen twice, with only one of the two knowing
// whether it was delivered.
//
// The consequence, said plainly rather than hidden: on a site whose SMS
// provider does NOT also publish conversations, a text sent from here goes out
// and leaves no trace in the hub. The answer to that is a conversation provider
// on that module, not a second record here.

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.reply')) return errorResponse('Forbidden', 403)

  const parsed = SmsBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return errorResponse(parsed.error.issues[0]?.message ?? 'That text could not be read.', 400)
  }

  const to = normaliseSmsNumber(parsed.data.to)
  if (!to) {
    return errorResponse(
      'That does not look like a phone number. Try it in full, e.g. 07700 900123 or +447700900123.',
      400,
    )
  }

  const provider = await getActiveSmsProvider()
  if (!provider) {
    return errorResponse('This site cannot send texts yet. Whoever looks after it can switch that on.', 400)
  }

  try {
    await provider.sendSms(to, parsed.data.body)
  } catch (err) {
    console.error('[unified-inbox] could not send the text:', err)
    return errorResponse('That text could not be sent. Nothing has gone out.', 502)
  }

  return NextResponse.json({ ok: true, to })
}
