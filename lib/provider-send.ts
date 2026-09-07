import {
  getThreadDetail,
  insertProviderMessage,
  recordLink,
  recountProviderThread,
  setThreadRead,
  threadHasLink,
} from './db'
import { htmlHasWriting } from './drafts'
import { htmlToText } from './html'
import { applyTextStyles } from './text-styles'
import { resolveProducts } from './products'
import { renderProductText } from './products/render'
import { flattenWithProducts, refKey, slotRefs } from './products/slots'
import type { ProductRef } from './products/types'
import type { ConversationTextStyles } from '@/lib/conversations/types'
import { pushProviderRead } from './provider-read'
import { providerForKey } from './provider-registry'
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
//
// WHAT A CHANNEL GETS IS WORDS. The seam hands the owning module one string, so
// the catalogue table an email would carry becomes the same list written out -
// the name, the options, the price and the address to look at it. Which is not a
// consolation prize: it is exactly what renderProductText already writes for the
// text half of every email this module sends, so a chair quoted in an enquiry
// and the same chair quoted in a reply say the same thing.
//
// WORDS ARE NOT THE SAME AS UNFORMATTED, though, and they used to be treated as
// if they were. WhatsApp has emphasis; it simply writes it with a marker on each
// side rather than with a tag, and a reply typed in bold was arriving with the
// bold quietly gone. So a channel declares its own markers through
// `capabilities.textStyles` and the markup is rewritten into them on the way
// out - see lib/text-styles.ts, which is handed the markers as data and knows
// no channel by name. A channel that declares nothing is flattened exactly as
// it always was.

export type ProviderSendResult =
  | { ok: true; messageId: string | null }
  | { ok: false; reason: string }

/**
 * The words to send a channel, with the products where they were put.
 *
 * The writing comes in as markup carrying a slot per product (see
 * lib/products/slots.ts). Each slot becomes that product's own lines; anything
 * picked with no slot to sit in - a draft written before the catalogue went into
 * the writing box - runs on at the end, which is where it used to print.
 *
 * Read fresh, like every other send path: what was stored is a reference, and
 * the name and the price are the shop's at the moment the message leaves.
 */
export async function replyWords(
  bodyHtml: string,
  refs: readonly ProductRef[] = [],
  /** What this channel writes emphasis as, straight off its own capabilities.
   *  Absent for a channel that takes plain words. */
  styles?: ConversationTextStyles | null,
): Promise<string> {
  /** The markers first, then the tags away: the emphasis lives in the tags, so
   *  once htmlToText has been over it there is nothing left to mark. */
  const flatten = (html: string) => htmlToText(applyTextStyles(html, styles))

  if (refs.length === 0) return flatten(bodyHtml)

  const resolved = await resolveProducts(refs)
  const byKey = new Map(resolved.map((one) => [refKey(one.choice), one.choice]))
  const slotted = new Set(slotRefs(bodyHtml).map(refKey))

  const words = flattenWithProducts(
    bodyHtml,
    (ref) => {
      const choice = byKey.get(refKey(ref))
      return choice ? renderProductText([choice]) : null
    },
    flatten,
  )

  const trailing = resolved
    .map((one) => one.choice)
    .filter((choice) => !slotted.has(refKey(choice)))
  if (trailing.length === 0) return words
  return [words, renderProductText(trailing)].filter(Boolean).join('\n\n')
}

export async function sendProviderReply(input: {
  threadId: string
  /** What to send, either as it was typed or as it already stood.
   *
   *  `html` is the writing box's own markup, and is the shape a reply arrives
   *  in. It is rendered HERE rather than by the caller, because rendering it
   *  needs the channel's markers and this is the function that resolves the
   *  channel - a caller that did it would have to resolve the provider a second
   *  time to find out what to render it into.
   *
   *  `text` is for a draft written before the box could hold markup, which is
   *  words already and has nothing to render. */
  body: { html: string } | { text: string }
  authorUserId: string
  authorName: string | null
  /** What was quoted, so the conversation ends up carrying it - the same row a
   *  purchase order or an order sits on. Already in the words; this is only
   *  about what the thread is ABOUT. */
  products?: readonly ProductRef[]
}): Promise<ProviderSendResult> {
  // Nothing written, refused before anything is looked up. Checked twice over:
  // here on what was typed, so an empty box costs no queries, and again on the
  // rendered words below, because rendering is where a body that was nothing
  // but a catalogue slot for a product since withdrawn comes out empty.
  const written = 'html' in input.body
    ? htmlHasWriting(input.body.html)
    : input.body.text.trim().length > 0
  if (!written) return { ok: false, reason: 'There is nothing to send.' }

  const thread = await getThreadDetail(input.threadId)
  if (!thread) return { ok: false, reason: 'That conversation is not here any more.' }
  if (!thread.providerModule || !thread.externalId) {
    return { ok: false, reason: 'That conversation did not come from another channel.' }
  }

  // A channel whose module has been removed keeps its conversations - they stay
  // readable and searchable (E20) - but there is nothing left to answer through,
  // and saying so plainly beats a failure from somewhere deeper.
  const resolved = await providerForKey(thread.providerModule)
  if (!resolved) {
    return { ok: false, reason: 'That channel cannot be answered from here.' }
  }
  if (!resolved.provider.capabilities?.reply || typeof resolved.provider.send !== 'function') {
    return { ok: false, reason: `${resolved.provider.label} conversations cannot be answered from here.` }
  }

  // Emphasis written the way this channel writes it, and the catalogue put
  // where it was put. Both need the channel, which is why the words are made
  // here and not at the two call sites.
  const body = ('html' in input.body
    ? await replyWords(
      input.body.html,
      input.products ?? [],
      resolved.provider.capabilities?.textStyles ?? null,
    )
    : input.body.text
  ).trim()
  if (!body) return { ok: false, reason: 'There is nothing to send.' }

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

  // Everything that was quoted, now attached to the conversation - exactly as it
  // is when the same products go out on an email. Checked first rather than left
  // to the insert: two messages quoting the same chair are one chair on the
  // conversation, not two rows of the same name.
  for (const { link } of await resolveProducts(input.products ?? [])) {
    if (await threadHasLink(thread.id, link.moduleName, link.recordType, link.recordId)) continue
    await recordLink({
      threadId: thread.id,
      personId: null,
      moduleName: link.moduleName,
      recordType: link.recordType,
      recordId: link.recordId,
      label: link.label,
      confidence: 100,
      linkedBy: 'user',
    })
  }

  // Answering something is the clearest possible statement that it has been
  // read, here and at the far end both.
  if (thread.unread) {
    await setThreadRead(thread.id, false)
    await pushProviderRead(thread)
  }

  return { ok: true, messageId }
}
