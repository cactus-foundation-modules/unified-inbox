// The site's front door.
//
//   GET  /api/m/unified-inbox/blocked-senders  - who is refused, for the
//        settings screen and for the Spam folder's own list, which are the two
//        places one can be let back in.
//   POST /api/m/unified-inbox/blocked-senders  - shut it, or open it again.
//
// SITE-WIDE, ON PURPOSE. A block covers every inbox the site has: the shared
// addresses, every colleague's own address, and the one nobody has opened since
// March. A block that only covered the inbox somebody happened to be standing
// in when they pressed the button is not a block - the sender writes to hello@
// instead and turns up in a different list an hour later.
//
// Which is exactly why POST takes the same grant as answering a message rather
// than the one for reading it. Marking a conversation as junk changes one
// person's own screen and takes `view`; turning a sender away changes what
// everybody on the site receives from now on, so it takes `reply` - the same
// line this module already draws for blocking somebody on a channel.
//
// Reading the list is the other way round: it is a fact about how the site is
// configured, it names colleagues, and it belongs with the rest of the settings.
// So it takes `manage` - which is also why the button in the Spam folder that
// opens the same list is only drawn for somebody who has it.
//
// NOTHING IS DELETED BY EITHER VERB. Blocking somebody does not touch the
// conversations they have already had here - often that history is the whole
// reason somebody wants them stopped. What they send while the door is shut is
// collected and dropped straight into the Spam folder, marked done and left
// unread (see migration 044), so unblocking them has nothing to go back for -
// it is all still there, in the bin, one press from being taken out again.
import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { normaliseAddress } from '@/modules/unified-inbox/lib/addresses'
import {
  blockSender,
  listBlockedSenders,
  unblockSender,
} from '@/modules/unified-inbox/lib/blocked-senders'
import { BlockedSenderBody } from '@/modules/unified-inbox/lib/validation'

export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'unifiedinbox.manage'))) return errorResponse('Forbidden', 403)

  const blocked = await listBlockedSenders()
  return NextResponse.json({
    blocked: blocked.map((row) => ({
      id: row.id,
      address: row.address,
      blockedByUserId: row.blockedByUserId,
      createdAt: row.createdAt.toISOString(),
    })),
  })
}

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'unifiedinbox.reply'))) return errorResponse('Forbidden', 403)

  const parsed = BlockedSenderBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That does not look like an address.', 400)

  // Normalised here as well as in the store, because the answer below has to be
  // the address that was actually written down rather than the one that was
  // typed - the settings screen lists what is stored, and two spellings of one
  // block on one screen is a screen nobody trusts.
  const address = normaliseAddress(parsed.data.address)
  if (!address.includes('@')) {
    return errorResponse('That does not look like an email address.', 400)
  }

  if (parsed.data.blocked) await blockSender(address, user.id)
  else await unblockSender(address)

  return NextResponse.json({ ok: true, address, blocked: parsed.data.blocked })
}
