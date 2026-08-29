import { inboxHref } from './list'
import type { Draft, DraftAttachment } from './types'

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
  subject?: string | null
  body?: string
  attachments?: unknown[]
}): boolean {
  if ((draft.body ?? '').trim()) return true
  if ((draft.subject ?? '').trim()) return true
  if ((draft.to ?? []).length > 0) return true
  if ((draft.cc ?? []).length > 0) return true
  return (draft.attachments ?? []).length > 0
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

/** The first line or so of what was written, for the list. Nothing is
 *  sanitised here because nothing is rendered as markup - a draft's body is
 *  text somebody typed, and it goes into the page as text. */
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
  subject: string | null
  body: string
  attachments: DraftAttachment[]
}

export function forComposer(draft: Draft): DraftForComposer {
  return {
    id: draft.id,
    inboxId: draft.inboxId,
    mode: draft.mode,
    to: draft.to,
    cc: draft.cc,
    subject: draft.subject,
    body: draft.body,
    attachments: draft.attachments,
  }
}

// ---------------------------------------------------------------------------
// Who may see a draft, and who may change one.
//
// These used to be the same question and are not any more. A draft filed on one
// of the site's addresses is now READ by whoever can read that address, exactly
// as every other message on that address already was - somebody covering for a
// colleague who is off can see what was half-written to the supplier rather than
// being told the conversation has nothing pending. A draft with no address on it
// is answering a conversation another module owns, and there is no guest list to
// grant sight through, so it stays with the person who wrote it.
//
// WRITING is a different question and has not moved. Editing, discarding and
// sending stay with the author: finishing somebody else's sentence and putting
// it in the post over their name is not the same favour as reading it.
// ---------------------------------------------------------------------------

/** Whether this person may READ this draft. Mirrors the SQL in `draftScope`
 *  (lib/db.ts) - if you change one, change the other, and the tests below are
 *  what will tell you that you did not. */
export function canReadDraft(
  draft: { authorUserId: string; inboxId: string | null },
  userId: string,
  visibleInboxIds: string[],
): boolean {
  if (draft.inboxId) return visibleInboxIds.includes(draft.inboxId)
  return draft.authorUserId === userId
}

/** Whether this person may change, discard or send this draft. */
export function canEditDraft(draft: { authorUserId: string }, userId: string): boolean {
  return draft.authorUserId === userId
}
