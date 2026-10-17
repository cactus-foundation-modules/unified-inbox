// POST /api/m/unified-inbox/threads/[id]/text - texts the person an email
// conversation is with, and writes the text onto that conversation.
//
// Offered from the dots beside Reply when their contact card has a mobile on
// it. The number is read off the card HERE, never taken from the browser, so
// a text sent from this conversation can only go to the person it is with.
// On a live chat the number is the one the visitor left, asked of the chat
// module (lib/text-links.ts), and the text can also be put in the chat.
//
// It goes out through core's SMS seam (lib/auth/sms.ts) exactly as a text from
// the compose menu does, and this module still holds no telephony credentials.
// What is different is the note it leaves behind: texts with this number now
// belong on this conversation (lib/text-links.ts), so the channel's own copy of
// this text is matched to the row written below rather than filed again, and
// the customer's reply lands here as an email would.
//
// The grant is the one answering the conversation by email takes: reply, on the
// address it lives in.
import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getActiveSmsProvider } from '@/lib/auth/sms'
import { siteDiallingCode } from '@/lib/phone.server'
import { canOpenThread, canReplyToInbox, threadAccessKind } from '@/modules/unified-inbox/lib/access'
import { getThreadDetail, recordEvent, reopenOnOurReply } from '@/modules/unified-inbox/lib/db'
import { sendProviderReply } from '@/modules/unified-inbox/lib/provider-send'
import { standDownScheduled } from '@/modules/unified-inbox/lib/stand-down'
import { linkTextsToThread, recordSentText, threadTextNumber } from '@/modules/unified-inbox/lib/text-links'
import { ThreadTextBody } from '@/modules/unified-inbox/lib/validation'

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.reply')) return errorResponse('Forbidden', 403)

  const parsed = ThreadTextBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return errorResponse(parsed.error.issues[0]?.message ?? 'That text could not be read.', 400)
  }

  const { id } = await ctx.params
  const thread = await getThreadDetail(id)
  // One refusal for "not there" and "not yours", for the reason the merge route
  // gives: telling them apart confirms a conversation exists in an address
  // somebody cannot see.
  if (!thread || !(await canOpenThread(user, thread))) {
    return errorResponse('That conversation is not here any more.', 404)
  }
  if (thread.mergedIntoId) {
    return errorResponse('That conversation has been merged into another one. Text them from that one.', 400)
  }
  // A channel's own conversation (a live chat nobody has filed in an address) is
  // answered by whoever may open it, which canOpenThread has just settled.
  const channelOwned = !!thread.providerModule && threadAccessKind(thread) === 'channel'
  if (!channelOwned && (!thread.inboxId || !(await canReplyToInbox(user, thread.inboxId)))) {
    return errorResponse('You do not have permission to answer this conversation.', 403)
  }

  const to = await threadTextNumber(thread, await siteDiallingCode())
  if (!to) {
    return errorResponse(
      'There is no mobile number on their contact card to text. Add one to the card and try again.',
      400,
    )
  }

  const provider = await getActiveSmsProvider()
  if (!provider) {
    return errorResponse('This site cannot send texts yet. Whoever looks after it can switch that on.', 400)
  }

  // Taken BEFORE it goes, so the channel's own copy - stamped by the network a
  // moment after this - is on the right side of the line and comes back here.
  const since = new Date()
  try {
    await provider.sendSms(to, parsed.data.body)
  } catch (err) {
    console.error('[unified-inbox] could not send a text from a conversation:', err)
    return errorResponse('That text could not be sent. Nothing has gone out.', 502)
  }

  // Recorded only once it has genuinely gone. The note first: if writing the
  // message fails, the channel's copy still arrives on the next collection and
  // lands here, which is where it belongs.
  // Only an email conversation takes over the texts that come back from this
  // number; a live chat is not given them, so a chat does not quietly start
  // collecting every text that person ever sends.
  if (!thread.providerModule) {
    await linkTextsToThread({ phone: to, threadId: thread.id, since, userId: user.id })
  }
  const sentAt = new Date()
  const messageId = await recordSentText({
    threadId: thread.id,
    phone: to,
    body: parsed.data.body,
    authorUserId: user.id,
    authorName: user.displayName ?? null,
    sentAt,
  })

  // Whatever an email reply does to the conversation, a text does too. Done is
  // reopened - answering something says it is not finished - and anybody
  // else's reply waiting to go out on it stands down (lib/stand-down.ts).
  if (await reopenOnOurReply(thread.id)) {
    await recordEvent(thread.id, user.id, 'woken', { was: 'done', ours: true, messageId })
  }
  await standDownScheduled({
    threadId: thread.id,
    messageId,
    direction: 'out',
    fromAddress: null,
    senderUserId: user.id,
  })

  // Also in the live chat: the same words go to the visitor through the chat
  // module like any chat reply, and sit in the conversation as one. The text
  // has already gone, so a chat that will not take it is reported rather than
  // failed - telling them "nothing was sent" would be a lie that ends in a
  // second text.
  let chatSent: boolean | undefined
  let chatError: string | undefined
  if (parsed.data.alsoChat && thread.providerModule) {
    const result = await sendProviderReply({
      threadId: thread.id,
      body: { text: parsed.data.body },
      authorUserId: user.id,
      authorName: user.displayName ?? null,
    })
    chatSent = result.ok
    if (!result.ok) chatError = result.reason
  }

  return NextResponse.json({ ok: true, to, messageId, chatSent, chatError })
}
