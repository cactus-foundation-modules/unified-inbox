import { inboxHref } from './list'
import type {
  Draft, DraftAttachment, DraftBodyFormat, DraftProduct, DraftSendState,
} from './types'

// ---------------------------------------------------------------------------
// Drafts: the pure half.
//
// Everything here is what a draft LOOKS like - what its row in the list says,
// where clicking it goes, and whether there is anything in it worth keeping.
// Nothing in this file opens a connection or writes a row, which is what makes
// the two decisions that actually cost something testable:
//
//   Whether a draft is empty. Saving an untouched composer would leave a row
//   that says nothing behind every conversation somebody merely looked at, and
//   a Drafts list full of blanks is worse than no Drafts list.
//
//   Where a saved draft is picked back up. A reply lives under its conversation
//   and a new message lives on the compose screen, and sending somebody to the
//   wrong one of those loses the writing in front of them.
// ---------------------------------------------------------------------------

/** Addresses as somebody types them: commas, semicolons, and whatever spacing
 *  they felt like. Shared by both composers so "a, b" means the same thing on
 *  the new-message screen as it does under a conversation. */
export function splitAddresses(value: string): string[] {
  return value.split(/[,;]/).map((address) => address.trim()).filter(Boolean)
}

/** What can be saved. An untouched composer is not a draft - it is a screen
 *  somebody opened and walked away from, and the difference matters because
 *  one of them belongs in the list and the other does not. */
export function isWorthSaving(draft: {
  to?: string[]
  cc?: string[]
  bcc?: string[]
  subject?: string | null
  body?: string
  attachments?: unknown[]
  products?: unknown[]
}): boolean {
  if ((draft.body ?? '').trim()) return true
  if ((draft.subject ?? '').trim()) return true
  if ((draft.to ?? []).length > 0) return true
  if ((draft.cc ?? []).length > 0) return true
  if ((draft.bcc ?? []).length > 0) return true
  if ((draft.attachments ?? []).length > 0) return true
  // A message that is nothing but two chairs off the catalogue is still
  // somebody's work: they went and found them.
  return (draft.products ?? []).length > 0
}

/** Who a draft is addressed to, in the one line the list has room for. A
 *  reply carries its recipients on the conversation rather than on the draft,
 *  so it says so rather than pretending to know. */
export function draftRecipientLabel(draft: {
  to: string[]
  threadId: string | null
}): string {
  if (draft.to.length === 1) return draft.to[0]!
  if (draft.to.length > 1) return `${draft.to[0]!} and ${draft.to.length - 1} other${draft.to.length > 2 ? 's' : ''}`
  return draft.threadId ? 'A reply' : 'No recipient yet'
}

export function draftSubjectLabel(draft: { subject: string | null }): string {
  const subject = (draft.subject ?? '').trim()
  return subject || '(no subject)'
}

/**
 * What a draft says, as words rather than as whatever it is stored in.
 *
 * A body written in the new box is markup, and the two places that show one
 * without sending it - the row in the Drafts list and the read-only view of a
 * colleague's - both want the words. Deliberately a flattener rather than a
 * sanitiser: nothing here goes into the page as markup, it goes in as TEXT, so
 * the tags are stripped for legibility and never trusted. The one place markup
 * is actually rendered is the writing box itself, and what it is handed was
 * cleaned on the way into the database.
 *
 * A body stored as text is handed back untouched, because "a < b" is a thing
 * somebody typed and not a tag.
 */
export function draftBodyText(draft: { body: string; bodyFormat?: DraftBodyFormat }): string {
  if (draft.bodyFormat !== 'html') return draft.body
  return draft.body
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Last, or an escaped "&lt;" turns back into a tag on the way through.
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Whether there is anything actually written in a box that holds markup. An
 *  empty one is not always an empty string - a browser will leave a stray break
 *  or a non-breaking space behind - and "you have written nothing" is the wrong
 *  thing to say to somebody who has, or the wrong thing to refuse to say to
 *  somebody who has not. */
export function htmlHasWriting(html: string): boolean {
  return draftBodyText({ body: html, bodyFormat: 'html' }).length > 0
}

/** The first line or so of what was written, for the list. Nothing is
 *  sanitised here because nothing is rendered as markup - what it is handed is
 *  words by the time it gets here, and it goes into the page as text. */
export function draftPreview(body: string, limit = 140): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, limit - 1).trimEnd()}…`
}

/**
 * Where a draft is picked back up.
 *
 * A reply goes to its conversation, because that is where the reply box is and
 * where the customer's own words are sitting above it. A new message goes to
 * the compose screen carrying its id. Either way Drafts stays the open tab, so
 * finishing one and going back for the next is one click rather than a hunt.
 */
export function draftHref(
  base: string,
  params: Record<string, string>,
  draft: { id: string; threadId: string | null },
): string {
  if (draft.threadId) {
    return inboxHref(base, params, {
      id: draft.threadId,
      compose: null,
      draft: null,
      person: null,
      page: null,
    })
  }
  return inboxHref(base, params, {
    compose: '1',
    draft: draft.id,
    id: null,
    person: null,
    page: null,
  })
}

/** The shape both composers hand to the browser. Dates are no use to a client
 *  component and a Date in props arrives as an empty object anyway, so they do
 *  not make the trip. */
export type DraftForComposer = {
  id: string
  inboxId: string | null
  mode: Draft['mode']
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string | null
  body: string
  /** What `body` is written in, so the box knows whether to drop it straight
   *  back in or turn its line breaks into markup first. */
  bodyFormat: DraftBodyFormat
  attachments: DraftAttachment[]
  /** The catalogue items on it, as references. The composer holds what each one
   *  is called and what it costs separately, fetched fresh - the draft only
   *  remembers WHICH. */
  products: DraftProduct[]
  /** When it goes out on its own, as an ISO stamp. A Date in props arrives at a
   *  client component as an empty object, so it makes the trip as a string. */
  sendAt: string | null
  sendState: DraftSendState
  sendError: string | null
  /** How long after it goes out the conversation should come back if nobody has
   *  answered, or null for a message nobody wants chasing. */
  followUpMinutes: number | null
  /** Whether mail from the recipient stood it down before it could leave. The
   *  conversation it was held by is not sent to the browser: the composer only
   *  has to say that the timer came off and why. */
  held: boolean
}

export function forComposer(draft: Draft): DraftForComposer {
  return {
    id: draft.id,
    inboxId: draft.inboxId,
    mode: draft.mode,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    body: draft.body,
    bodyFormat: draft.bodyFormat,
    attachments: draft.attachments,
    products: draft.products,
    sendAt: draft.sendAt ? draft.sendAt.toISOString() : null,
    sendState: draft.sendState,
    sendError: draft.sendError,
    followUpMinutes: draft.followUpMinutes,
    held: draft.heldByThreadId !== null,
  }
}

// ---------------------------------------------------------------------------
// Who may see a draft, and who may change one.
//
// One question, one answer: a draft belongs to whoever wrote it. Reading it,
// opening it, changing it, discarding it and sending it are all "is this
// yours", and sharing the address it is filed on grants none of them.
//
// A shared inbox shares what has been sent and what has arrived. Half-written
// text is neither. Somebody typing a price they have not checked yet, or an
// apology they have not decided to make, gets the privacy those words get in
// every other mail program - which is what migrations/013_drafts.sql set out to
// build, and what this is back to after a spell of letting colleagues read and
// finish each other's.
//
// The SQL twin is `draftScope` in lib/db.ts, which is the one that actually
// keeps anybody out - if you change one, change the other, and the tests below
// are what will tell you that you did not.
// ---------------------------------------------------------------------------

/** Whether this person may READ this draft. */
export function canReadDraft(
  draft: { authorUserId: string },
  userId: string,
): boolean {
  return draft.authorUserId === userId
}

/** Whether this person may change, discard or send this draft. The same
 *  question as reading it: a draft nobody else may see is a draft nobody else
 *  may finish. Kept as its own name because the two are separate ideas that
 *  happen to have one answer, and the screens read better saying which they
 *  mean. */
export function canEditDraft(
  draft: { authorUserId: string },
  userId: string,
): boolean {
  return draft.authorUserId === userId
}
