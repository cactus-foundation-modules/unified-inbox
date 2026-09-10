import { plainTextToHtml } from './scheduled'
import { draftBodyText } from './drafts'
import { sendMessage } from './send'
import { sendProviderReply } from './provider-send'
import type { ThreadRow } from './db'
import type { Draft } from './types'

// ---------------------------------------------------------------------------
// Turning a draft row into a message that has actually left.
//
// Two things do this, and they used to be one function with the rights checks
// braided through it: the queue posting something whose time has come, and a
// colleague pressing Send on somebody's half-written reply from the Drafts
// folder under their name. What they share is everything about HOW a stored
// draft becomes a send - which body, which recipients, which catalogue prices,
// which idempotency key. What they do not share is a single line about who may
// do it.
//
// So the rights live with the callers, where the answers differ, and nothing in
// this file checks anything. Read that as the warning it is: postDraft posts.
// Every caller must have settled who is allowed before it gets here.
// ---------------------------------------------------------------------------

export type DraftPostResult =
  | { ok: true; threadId: string }
  | { ok: false; reason: string }

/** The address a stored draft would leave as. A reply takes the conversation's
 *  when it has none of its own, which is the same order the composer and the
 *  send route work it out in. Null is a draft with nowhere to go - one whose
 *  address has been deleted since, or one written on a conversation another
 *  module owns, where the module is the sender rather than an address. */
export function draftSendingInboxId(
  draft: Pick<Draft, 'inboxId'>,
  thread: Pick<ThreadRow, 'inboxId'> | null,
): string | null {
  return draft.inboxId ?? thread?.inboxId ?? null
}

/**
 * Post a draft exactly as it stands. NO rights are checked here - see above.
 *
 * `sentByUserId` is whoever is answerable for the message going now: the author
 * when the queue posts one on their behalf, and the colleague who pressed the
 * button when somebody sends one out for them. It is what the Sent folder
 * credits, and it is deliberately not the same idea as whose writing this is.
 * The signature is untouched by it either way - an address that is somebody's
 * own signs as them whoever presses Send, which is settled in lib/send.ts.
 *
 * `idempotencyKey` must be stable for one draft and distinct between the two
 * roads to the mail server, so the same press arriving twice is one email.
 */
export async function postDraft(
  draft: Draft,
  thread: ThreadRow | null,
  options: { sentByUserId: string; idempotencyKey: string },
): Promise<DraftPostResult> {
  // A conversation another module owns - a chat, an enquiry, a text. It goes
  // back out the way it came in.
  if (thread?.providerModule) {
    if (draft.mode === 'forward' || draft.mode === 'new') {
      return { ok: false, reason: 'This kind of conversation can be replied to, but not forwarded.' }
    }
    const result = await sendProviderReply({
      threadId: thread.id,
      // A body written in the box is markup with the catalogue slotted into it,
      // and what survives of the markup is the channel's own answer - so it
      // goes over as it stands and is rendered there. One written before the
      // box could hold any is words already and has nothing to render.
      body: draft.bodyFormat === 'html'
        ? { html: draft.body }
        : { text: draftBodyText(draft) },
      authorUserId: options.sentByUserId,
      authorName: null,
      products: draft.products,
    })
    return result.ok ? { ok: true, threadId: thread.id } : { ok: false, reason: result.reason }
  }

  const inboxId = draftSendingInboxId(draft, thread)
  if (!inboxId) {
    return { ok: false, reason: 'There is no address left to send it from, so it stayed here.' }
  }

  const result = await sendMessage({
    threadId: draft.threadId ?? undefined,
    inboxId,
    // Whichever message it was written against, so a reply set for Monday
    // quotes the message somebody answered rather than whatever arrived over
    // the weekend. Null is the newest, which is what it always did.
    inReplyToMessageId: draft.inReplyToMessageId ?? undefined,
    mode: draft.mode,
    to: draft.to.length > 0 ? draft.to : undefined,
    cc: draft.cc.length > 0 ? draft.cc : undefined,
    bcc: draft.bcc.length > 0 ? draft.bcc : undefined,
    subject: draft.subject ?? undefined,
    // Stored as it was typed, which is what makes the box give back what went
    // into it. A body written in the new box already IS markup and goes as it
    // stands; one written before the box could hold any is escaped here, at the
    // last moment, the same way the composer used to do it.
    bodyHtml: draft.bodyFormat === 'html' ? draft.body : plainTextToHtml(draft.body),
    attachments: draft.attachments.map((file) => ({
      key: file.key,
      url: file.url,
      filename: file.filename,
      contentType: file.contentType,
    })),
    // Read fresh as it goes out, which is the whole reason a draft stores
    // references rather than prices: a quotation set for Monday morning quotes
    // Monday morning's catalogue.
    products: draft.products,
    includeOriginalAttachments: draft.mode === 'forward',
    idempotencyKey: options.idempotencyKey,
    authorUserId: options.sentByUserId,
  })

  // The conversation the message landed on, which for one starting a new
  // conversation did not exist until a moment ago - and is exactly the one a
  // follow-up has to be set on.
  return result.ok ? { ok: true, threadId: result.threadId } : { ok: false, reason: result.reason }
}
