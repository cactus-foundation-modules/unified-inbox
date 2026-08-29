import type { MediaProviderType } from '@prisma/client'
import { deleteMedia } from '@/lib/media/upload'
import {
  deletePersonRow,
  deleteThreads,
  exportMessagesForThreads,
  exportThreadsForPerson,
  getOrganisation,
  getPerson,
  linksForPerson,
  listIdentities,
  listPersonEvents,
  outboundLogForAddresses,
  personErasePreview,
  storedObjectsForThreads,
  threadIdsForPerson,
  type PersonErasePreview,
} from './db'
import { addressesForPerson } from './identity'

// ---------------------------------------------------------------------------
// What we hold about one person, handed over or taken away (D17).
//
// Both halves are administrator-only and both are deliberately HUB-ONLY, which
// is the single most important thing about them (E22). Erasing somebody here
// removes their conversations with this site. It does not remove their orders,
// their invoices, their quotes or their member account: those belong to other
// modules, which have their own records, their own reasons for keeping them and
// in several cases their own legal obligation to. A button here that quietly
// took three years of orders with it would be a far worse outcome than a button
// that says plainly what it covers - so the confirmation names both halves, and
// so does the export.
//
// The export is the same information the person's own page shows, plus the
// bodies of the messages, in a file. It is not a report and it is not styled:
// it is a plain record, because the thing it answers is a legal request rather
// than a browsing session.
// ---------------------------------------------------------------------------

export type PersonExport = {
  /** Plain English at the top of the file, because whoever opens it next may be
   *  a solicitor rather than the person who exported it. */
  about: string
  notIncluded: string[]
  exportedAt: string
  person: {
    id: string
    displayName: string | null
    primaryEmail: string | null
    organisation: string | null
    notes: string | null
    knownSince: string
  }
  identities: Array<{ kind: string; value: string; firstSeen: string }>
  conversations: Array<{
    id: string
    channel: string
    inbox: string | null
    subject: string | null
    status: string
    lastMessageAt: string | null
    messages: Array<{
      direction: string
      channel: string
      subject: string | null
      from: string | null
      to: string[]
      cc: string[]
      sentAt: string | null
      text: string | null
      html: string | null
      attachments: Array<{ filename: string; contentType: string | null; sizeBytes: number | null }>
    }>
  }>
  automatedEmailsSent: Array<{ subject: string; sentAt: string; status: string }>
  attachedRecords: Array<{ module: string; type: string; reference: string; label: string | null }>
  changes: Array<{ what: string; when: string }>
}

const NOT_INCLUDED = [
  'Their orders, invoices, quotes, purchase orders or member account. Those are held by the other parts of this site and are not touched by anything on this screen.',
  'The contents of the automated emails listed below. The site keeps a record that each one was sent and what it was about, and never keeps a copy of what it said.',
  'Anything held by the services that carry the messages - the mail provider, the live chat service, the telephone provider - which keep their own records under their own terms.',
]

/**
 * Everything this module holds about one person, as a plain object ready to be
 * written out as JSON. Bodies included: an export that left out what was
 * actually said would not answer the question it is asked for.
 */
export async function exportPerson(personId: string): Promise<PersonExport | null> {
  const person = await getPerson(personId)
  if (!person) return null

  const [identities, threads, links, events, addresses] = await Promise.all([
    listIdentities(personId),
    exportThreadsForPerson(personId),
    linksForPerson(personId),
    listPersonEvents(personId),
    addressesForPerson(personId),
  ])
  const organisation = person.organisationId ? await getOrganisation(person.organisationId) : null
  const messages = await exportMessagesForThreads(threads.map((t) => t.id))
  const outbound = await outboundLogForAddresses(addresses)

  const byThread = new Map<string, typeof messages>()
  for (const message of messages) {
    const list = byThread.get(message.threadId) ?? []
    list.push(message)
    byThread.set(message.threadId, list)
  }

  return {
    about:
      'Everything the conversation hub on this site holds about one person: who we understand them to be, how to reach them, and every message exchanged with them.',
    notIncluded: NOT_INCLUDED,
    exportedAt: new Date().toISOString(),
    person: {
      id: person.id,
      displayName: person.displayName,
      primaryEmail: person.primaryEmail,
      organisation: organisation?.name ?? person.organisationName,
      notes: person.notes,
      knownSince: person.createdAt.toISOString(),
    },
    identities: identities.map((i) => ({
      kind: i.kind,
      value: i.value,
      firstSeen: i.createdAt.toISOString(),
    })),
    conversations: threads.map((thread) => ({
      id: thread.id,
      channel: thread.channel,
      inbox: thread.inboxName,
      subject: thread.subject,
      status: thread.status,
      lastMessageAt: thread.lastMessageAt ? thread.lastMessageAt.toISOString() : null,
      messages: (byThread.get(thread.id) ?? []).map((m) => ({
        direction: m.direction,
        channel: m.channel,
        subject: m.subject,
        from: m.fromAddress ?? m.fromPhone ?? m.fromName,
        to: m.toAddresses,
        cc: m.ccAddresses,
        sentAt: m.sentAt ? m.sentAt.toISOString() : null,
        text: m.bodyText,
        html: m.bodyHtml,
        attachments: m.attachments,
      })),
    })),
    automatedEmailsSent: outbound.map((row) => ({
      subject: row.subject,
      sentAt: row.sentAt.toISOString(),
      status: row.status,
    })),
    attachedRecords: links.map((link) => ({
      module: link.moduleName,
      type: link.recordType,
      reference: link.recordId,
      label: link.label,
    })),
    changes: events.map((event) => ({ what: event.kind, when: event.createdAt.toISOString() })),
  }
}

/** A filename somebody can find again in six months. */
export function exportFilename(person: { displayName: string | null; primaryEmail: string | null; id: string }): string {
  const stem = (person.primaryEmail || person.displayName || person.id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'person'
  return `${stem}-conversations.json`
}

export type EraseOutcome = {
  conversations: number
  storedObjects: number
  storedObjectFailures: number
}

/**
 * Removes one person and their conversations with this site, and nothing else.
 *
 * Stored attachments go before their rows, on the same reasoning as the
 * retention sweep: an object left in storage is recoverable and visible to the
 * storage check, whereas a row pointing at bytes that have gone is neither.
 *
 * The caller has already shown the person doing this a preview naming exactly
 * what goes and what stays. Nothing here writes to another module's tables and
 * nothing here touches core's delivery ledger - see E22 and the note above.
 */
export async function erasePerson(personId: string): Promise<EraseOutcome> {
  const threadIds = await threadIdsForPerson(personId)
  const outcome: EraseOutcome = { conversations: 0, storedObjects: 0, storedObjectFailures: 0 }

  if (threadIds.length > 0) {
    const objects = await storedObjectsForThreads(threadIds)
    for (const object of objects) {
      try {
        await deleteMedia(object.mediaProvider as MediaProviderType, object.mediaKey)
        outcome.storedObjects += 1
      } catch (err) {
        outcome.storedObjectFailures += 1
        console.warn('[unified-inbox] erase could not remove a stored attachment:', err)
      }
    }
    outcome.conversations = await deleteThreads(threadIds)
  }

  await deletePersonRow(personId)
  return outcome
}

export type { PersonErasePreview }
export { personErasePreview }
