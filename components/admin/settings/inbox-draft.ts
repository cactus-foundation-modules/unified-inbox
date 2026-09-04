import type { SignatureKind } from './types'

/** A blank address form. Its own file because both the inbox form and the
 *  signature editor inside it are written against this shape, and having either
 *  of them own it would put the two in a circle. */
export function blankInbox() {
  return {
    name: '',
    address: '',
    connectionId: '',
    imapFolder: 'INBOX',
    sentFolder: '',
    isCatchAll: false,
    folderOwnsMail: false,
    sendTransport: 'brevo' as 'brevo' | 'smtp',
    brevoApiKey: '',
    smtpHost: '',
    smtpPort: '',
    smtpUsername: '',
    smtpPassword: '',
    fromName: '',
    signatureKind: 'markdown' as SignatureKind,
    signature: '',
    signatureHtml: '',
    signaturePuck: null as unknown,
    appendToSent: false,
    sortOrder: 0,
  }
}

export type InboxDraft = ReturnType<typeof blankInbox>
