import type { MessageDestination, MessageDestinationProvider } from '@/lib/conversations/types'
import { listInboxes } from './db'

// The site's inboxes, offered to whoever is building a page that collects
// something from a stranger.
//
// This is the publishing half of `core.message-destinations`. A contact form,
// a booking request, a callback slip: each of them asks core for the list, puts
// it in front of the person editing the page, and hands the chosen id back
// later on the conversation it produces. Nothing in that chain knows this
// module exists, which is the point - the form still works on a site that has
// never heard of a mail account, it simply has one choice fewer to offer.
//
// Every inbox is offered, individual ones included. An address that is one
// person's own post is an odd place to point a public form and it is not this
// module's business to say so: a one-person business quite reasonably has
// nothing else, and the address is written under the name so nobody picks one
// by accident.
//
// SERVER ONLY - the manifest entry says so, and it reads this module's tables.

export const unifiedInboxMessageDestinations: MessageDestinationProvider = {
  label: 'Inboxes',
  async list(): Promise<MessageDestination[]> {
    const inboxes = await listInboxes()
    return inboxes.map((inbox) => ({
      id: inbox.id,
      label: inbox.name,
      detail: inbox.address || null,
    }))
  },
}
