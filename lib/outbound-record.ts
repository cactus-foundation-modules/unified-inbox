import { nanoid } from 'nanoid'
import { getActiveMediaProvider, isMediaProviderConfigured } from '@/lib/config/env'
import type { OutboundEmailRecorder, RecordedOutboundEmail } from '@/lib/email/record'
import {
  createOutboundThread,
  findThreadByKey,
  getInbox,
  insertOutboundAttachment,
  insertOutboundMessage,
  listInboxes,
  recordEvent,
  reopenOnReply,
  settleDelivery,
  touchThread,
} from './db'
import { getModuleCopyInboxId } from './module-senders'
import { generateMessageId } from './compose'
import { normaliseAddress } from './addresses'
import { buildSnippet, cleanMessageId, normaliseSubject } from './threading'
import { cacheAttachment } from './attachments'
import { htmlToText } from './html'

// ---------------------------------------------------------------------------
// Core handing this module a copy of another module's automatic email
// (core.outbound-email-record - see core's lib/email/record.ts).
//
// The companion to outbound-identity.ts. That one says which of the site's
// addresses purchasing writes from, so a supplier's reply comes back to the
// people chasing the order. This one puts the thing they are replying TO in
// the same place: a purchase order sent to a supplier starts a conversation in
// the inbox it is filed to, and the supplier's answer lands underneath it
// instead of arriving on its own with nobody able to see what we asked for.
//
// Its own switch since migration 046, and deliberately not the sending one.
// The shop's order emails are the case that separated them: they go out through
// the site's sending service and never touch a mail folder, so nothing shows
// what the customer was told - and yet changing the address a confirmation
// arrives from is a customer-facing decision an owner may not want to take to
// get that copy. A module nobody has chosen a filing inbox for is filed
// nowhere, exactly as before.
//
// Never throws. Core catches anyway, but a purchase order that reached the
// supplier and then reported itself as failed because a filing write went wrong
// would be the worst outcome available.
// ---------------------------------------------------------------------------

/**
 * Files one sent email as a conversation of its own.
 *
 * A NEW conversation every time unless the module names one (`threadKey`),
 * deliberately. Header threading then does the rest: the service's own
 * Message-ID is stored on the row, so when the supplier answers, their
 * In-Reply-To finds this thread and the answer lands under the order rather
 * than starting a third one (see threadsForMessageIds).
 */
async function record(email: RecordedOutboundEmail): Promise<void> {
  const inboxId = await getModuleCopyInboxId(email.moduleName)
  if (!inboxId) return

  // Nulled out with its inbox (ON DELETE SET NULL), so this is only ever null
  // in the gap between a delete and the row being swept.
  const inbox = await getInbox(inboxId)
  if (!inbox) return

  // Mail to one of our own inboxes - the shop telling staff about a new order -
  // comes straight back through the mail account as a received message. Filing
  // the sent copy as well shows the same email twice, once as something we
  // wrote, so only the received one is kept.
  const ownAddresses = new Set((await listInboxes()).map((i) => normaliseAddress(i.address)))
  if ([...email.to, ...email.cc].some((a) => ownAddresses.has(normaliseAddress(a)))) return

  const text = email.text || htmlToText(email.html)
  const subject = email.subject || '(no subject)'

  // Asked before the message is written, because the row has to say whether it
  // carries anything: a site with no storage set up cannot keep the document,
  // and a paperclip that opens onto an error is worse than no paperclip.
  const provider = email.attachments.length > 0 ? await getActiveMediaProvider() : null
  const keepFiles = !!provider && isMediaProviderConfigured(provider)
  const attachmentBytes = keepFiles
    ? email.attachments.reduce((total, file) => total + file.content.byteLength, 0)
    : 0

  // A module that names the conversation an email belongs to (a shop, per
  // order) has every email of that name filed on the one thread, whatever the
  // subject - which is the point, since an order's emails each have their own.
  // Left unnamed, a conversation each, exactly as before.
  const threadKey = email.threadKey?.trim() || null
  const existingThreadId = threadKey ? await findThreadByKey(inboxId, threadKey) : null
  const threadId = existingThreadId ?? await createOutboundThread({
    inboxId,
    subject,
    subjectNormalised: normaliseSubject(subject),
    preview: buildSnippet(text),
    threadKey,
  })

  const { row } = await insertOutboundMessage({
    threadId,
    inboxId,
    // Nothing retries these - the module that sent it owns that decision - so
    // the token only has to be unique.
    idempotencyKey: `mod-${nanoid(20)}`,
    // Cleaned of its angle brackets, because that is how every Message-ID in
    // uin_messages is stored and the two have to compare equal. Most services
    // stamp their own id over ours anyway, which is why the one that matters is
    // the provider's, below.
    messageIdHeader: cleanMessageId(email.messageIdHeader) ?? generateMessageId(inbox.address),
    inReplyTo: null,
    references: [],
    fromName: email.from.name ?? null,
    fromAddress: email.from.address,
    toAddresses: email.to,
    ccAddresses: email.cc,
    subject,
    bodyText: text,
    bodyHtml: email.html,
    snippet: buildSnippet(text),
    hasAttachments: keepFiles,
    sizeBytes: Buffer.byteLength(email.html) + Buffer.byteLength(text) + attachmentBytes,
    // No person pressed Send. A machine did, on a schedule or on the back of
    // somebody approving an order two screens away.
    authorUserId: null,
  })

  // Straight to settled: core only offers a message here once the service has
  // accepted it, so there is no in-flight state to represent.
  await settleDelivery(row.id, {
    status: 'sent',
    // Cleaned, because an inbound In-Reply-To is cleaned too and the two have
    // to compare equal for the reply to find its way back here.
    providerMessageId: cleanMessageId(email.providerMessageId ?? null),
    // The log row core wrote for it, which is how an open, a click or a bounce
    // the site's own tracking sees later finds this copy (see own-tracking.ts).
    // Missing on an older core, which simply means no such events arrive.
    tracking: {
      emailLogId: email.emailLogId ?? null,
      sentVia: email.transport ?? null,
      tracked: email.tracked ?? false,
    },
  })

  if (keepFiles) await keepAttachments(row.id, email)

  // A new thread starts out counted and previewed by its creation; one that
  // already held mail has to be rolled forward, or the list keeps showing the
  // first email's preview and the order's newest email never moves it up.
  if (existingThreadId) {
    await touchThread(threadId, {
      sentAt: new Date(),
      direction: 'out',
      preview: buildSnippet(text),
      subject,
      subjectNormalised: normaliseSubject(subject),
      markUnread: false,
      inboxId,
      arrivedNow: false,
    })

    // Another email on an order's conversation is the order moving, which is
    // the end of whatever was waiting for it: the "done" somebody gave it when
    // the last email went out, or the sleep they set until the delivery day
    // (the very email that ends the wait is the courier's window arriving
    // before it). Left asleep it would sit out of Open with a new email in it
    // and nobody to see it. The same rule a customer's reply gets, and unlike
    // a hand-typed reply, which leaves a sleep alone: nobody here chose to
    // send this one, so there is no sleep it could be part of.
    const was = await reopenOnReply(threadId)
    if (was) await recordEvent(threadId, null, 'woken', { was, cause: 'module-email', direction: 'out', messageId: row.id })
  }
}

/**
 * The files that travelled with it, stored under this module's own prefix - no
 * media library row, exactly as an inbound attachment gets none, or a
 * supplier's pricing would turn up in the picker for anybody holding media
 * permission.
 *
 * The document is most of what a purchase order IS, and a copy of the email
 * without it is a covering note.
 *
 * Never throws - a failure here costs a copy of an attachment, and the email
 * itself is already filed.
 */
async function keepAttachments(messageId: string, email: RecordedOutboundEmail): Promise<void> {
  for (const file of email.attachments) {
    try {
      const attachmentId = await insertOutboundAttachment({
        messageId,
        filename: file.filename,
        contentType: file.contentType ?? 'application/pdf',
        sizeBytes: file.content.byteLength,
        // Filled in by cacheAttachment once the bytes are in storage.
        mediaKey: null,
        mediaProvider: null,
        mediaUrl: null,
      })
      await cacheAttachment(
        { id: attachmentId, messageId, filename: file.filename },
        Buffer.from(file.content),
        file.contentType ?? 'application/pdf',
      )
    } catch (error) {
      console.error('[unified-inbox] could not keep', file.filename, 'from', email.moduleName, error)
    }
  }
}

export const unifiedInboxOutboundRecord: OutboundEmailRecorder = { record }
