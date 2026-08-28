import type { OutgoingAttachment } from './compose'

// ---------------------------------------------------------------------------
// The raw RFC 5322 message, for copying a reply into the real Sent folder.
//
// Brevo posts JSON and hands the wire format nothing to look at, so this exists
// solely for IMAP APPEND: the mail server wants an actual message, headers and
// all, and it has to be OUR copy carrying OUR Message-ID or the next sync finds
// it in Sent and files it as a newly discovered email (E11).
//
// Nodemailer's MailComposer builds it. Hand-rolling MIME is a decade of
// other people's bug reports - quoted-printable, header folding, 8-bit
// transfer encodings, the lot - and nodemailer is already a core dependency
// because it is one of the two send transports.
// ---------------------------------------------------------------------------

export type RawMessageInput = {
  from: { name: string | null; address: string }
  to: string[]
  cc: string[]
  replyTo?: string | null
  subject: string
  html: string
  text: string
  headers: Record<string, string>
  attachments: Array<OutgoingAttachment & { content: Buffer }>
  sentAt: Date
}

/**
 * Builds the message as it would have gone over the wire.
 *
 * This is a reconstruction, not a capture - Brevo sends its own rendering and
 * adds its own trace headers on the way out, so the copy in Sent is the same
 * message rather than a byte-identical one. That is what every mail client
 * that BCCs itself does too, and it is what the owner's phone needs in order
 * to show the reply their colleague wrote.
 */
export async function buildRawMessage(input: RawMessageInput): Promise<Buffer> {
  const { default: MailComposer } = await import('nodemailer/lib/mail-composer')

  const composer = new MailComposer({
    from: input.from.name
      ? { name: input.from.name, address: input.from.address }
      : input.from.address,
    to: input.to,
    ...(input.cc.length ? { cc: input.cc } : {}),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    subject: input.subject,
    html: input.html,
    text: input.text,
    date: input.sentAt,
    headers: input.headers,
    ...(input.attachments.length
      ? {
          attachments: input.attachments.map((file) => ({
            filename: file.filename,
            content: file.content,
            ...(file.contentType ? { contentType: file.contentType } : {}),
          })),
        }
      : {}),
  })

  return await composer.compile().build()
}
