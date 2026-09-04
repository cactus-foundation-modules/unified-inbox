import { nanoid } from 'nanoid'
import { getActiveMediaProvider, isMediaProviderConfigured } from '@/lib/config/env'
import type { OutboundEmailRecorder, RecordedOutboundEmail } from '@/lib/email/record'
import {
  createOutboundThread,
  getInbox,
  insertOutboundAttachment,
  insertOutboundMessage,
  settleDelivery,
} from './db'
import { getModuleSenderInboxId } from './module-senders'
import { generateMessageId } from './compose'
import { buildSnippet, cleanMessageId, normaliseSubject } from './threading'
import { cacheAttachment } from './attachments'
import { htmlToText } from './html'

// ---------------------------------------------------------------------------
// Core handing this module a copy of another module's automatic email
// (core.outbound-email-record - see core's lib/email/record.ts).
//
// The other half of outbound-identity.ts. That one says which of the site's
// addresses purchasing writes from, so a supplier's reply comes back to the
// people chasing the order. This one puts the thing they are replying TO in
// the same place: a purchase order sent to a supplier starts a conversation in
// the inbox it left as, and the supplier's answer lands underneath it instead
// of arriving on its own with nobody able to see what we asked for.
//
// The switch is the one the site has already thrown. An inbox chosen for a
// module on that module's settings tab means "this module's post is ours", and
// a module nobody has chosen an inbox for is filed nowhere, exactly as before -
// there would be no inbox to put it in and no address for anyone to reply to.
//
// Never throws. Core catches anyway, but a purchase order that reached the
// supplier and then reported itself as failed because a filing write went wrong
// would be the worst outcome available.
// ---------------------------------------------------------------------------

/**
 * Files one sent email as a conversation of its own.
 *
 * A NEW conversation every time, deliberately. Header threading then does the
 * rest: the service's own Message-ID is stored on the row, so when the supplier
 * answers, their In-Reply-To finds this thread and the answer lands under the
 * order rather than starting a third one (see threadsForMessageIds).
 */
async function record(email: RecordedOutboundEmail): Promise<void> {
  const inboxId = await getModuleSenderInboxId(email.moduleName)
  if (!inboxId) return

  // Cascaded away with its inbox, so this is only ever null in the gap between
  // a delete and its cascade.
  const inbox = await getInbox(inboxId)
  if (!inbox) return

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

  const threadId = await createOutboundThread({
    inboxId,
    subject,
    subjectNormalised: normaliseSubject(subject),
    preview: buildSnippet(text),
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
  })

  if (keepFiles) await keepAttachments(row.id, email)
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
