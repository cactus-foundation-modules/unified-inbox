import {
  getThreadDetail,
  insertProviderMessage,
  recountProviderThread,
  setThreadRead,
} from './db'
import { providerForModule } from './provider-registry'
import { buildSnippet } from './threading'

// Answering a conversation somebody else's module owns.
//
// An email leaves this module through Brevo and is ours from end to end. A chat
// reply is not: it has to go back out through the module that owns the chat, so
// that what the customer sees is a genuine reply from the site's own live chat,
// attributed to the colleague who wrote it, and so the phone app that colleague
// answers from agrees with the admin. The same goes for an enquiry, where the
// contact form's own signature and email design apply, and for a text.
//
// Which means this file sends nothing itself. It asks, it records what was
// sent, and it turns a failure into a sentence somebody can act on.

export type ProviderSendResult =
  | { ok: true; messageId: string | null }
  | { ok: false; reason: string }

export async function sendProviderReply(input: {
  threadId: string
  text: string
  authorUserId: string
  authorName: string | null
}): Promise<ProviderSendResult> {
  const body = input.text.trim()
  if (!body) return { ok: false, reason: 'There is nothing to send.' }

  const thread = await getThreadDetail(input.threadId)
  if (!thread) return { ok: false, reason: 'That conversation is not here any more.' }
  if (!thread.providerModule || !thread.externalId) {
    return { ok: false, reason: 'That conversation did not come from another channel.' }
  }

  // A channel whose module has been removed keeps its conversations - they stay
  // readable and searchable (E20) - but there is nothing left to answer through,
  // and saying so plainly beats a failure from somewhere deeper.
  const resolved = await providerForModule(thread.providerModule)
  if (!resolved) {
    return {
      ok: false,
      reason: 'The part of the site that handles this channel is no longer installed, so this cannot be answered here.',
    }
  }
  if (!resolved.provider.capabilities?.reply || typeof resolved.provider.send !== 'function') {
    return { ok: false, reason: `${resolved.provider.label} conversations cannot be answered from here.` }
  }

  try {
    await resolved.provider.send(thread.externalId, {
      text: body,
      authorUserId: input.authorUserId,
    })
  } catch (err) {
    // The owning module knows why its own send failed and says so in English -
    // "you have not connected your chat account yet" is a sentence somebody can
    // do something about, and it is not ours to rewrite (E26).
    const reason = err instanceof Error && err.message.trim()
      ? err.message.trim()
      : 'That reply could not be sent.'
    console.error(`[unified-inbox] ${thread.providerModule} would not send a reply:`, err)
    return { ok: false, reason }
  }

  // Recorded only once it has genuinely gone. The owning module holds the real
  // copy and the next tick would collect it anyway; writing it now is so the
  // person who pressed Send sees their own words straight away rather than at
  // some point in the next hour.
  const sentAt = new Date()
  const messageId = await insertProviderMessage({
    threadId: thread.id,
    providerModule: thread.providerModule,
    // Ours until the far end's own id for it arrives on the next pass, at which
    // point that copy is a second row - which is why this one is stamped in a
    // shape no provider issues, so the two can be told apart by eye.
    providerMessageId: `uin-out:${sentAt.getTime()}:${input.authorUserId}`,
    direction: 'out',
    channel: thread.channel,
    fromName: input.authorName,
    fromAddress: null,
    fromPhone: null,
    subject: thread.subject,
    bodyText: body,
    bodyHtml: null,
    snippet: buildSnippet(body),
    sentAt,
  })
  await recountProviderThread(thread.id)
  // Answering something is the clearest possible statement that it has been
  // read.
  if (thread.unread) await setThreadRead(thread.id, false)

  return { ok: true, messageId }
}
