import { BRANDING_DEFAULTS } from '@/lib/config/branding'
import { getAdminPathCached } from '@/lib/config/site'
import { hasPermission } from '@/lib/permissions/check'
import type { SessionUser } from '@/lib/auth/session'
import { visibleInboxIds } from './access'
import { countThreads, listInboxes, listThreads, type ThreadListFilters } from './db'
import {
  inboxBase,
  listHrefFor,
  MAX_ARRIVAL_AGE_MS,
  MAX_ARRIVALS,
  threadHrefFor,
  type Arrival,
  type ArrivalsReply,
} from './notify'

// ---------------------------------------------------------------------------
// "What has landed for this person?" - the one question both roads a nudge
// travels ask. The browser asks it of the site with a mark in hand; the site
// asks it on the browser's behalf the moment it has collected mail, with the
// conversations it has just filed. See lib/notify.ts for the reasoning.
//
// THE ACCESS RULE RUNS THROUGH IT UNCHANGED (E17). The inboxes this person may
// read are resolved and passed INTO the query, exactly as the screen does, so a
// subject line from accounts@ can no more reach somebody through a nudge than
// through the list. This is the whole reason it is a function of its own
// rather than a count bolted onto something general: it hands out the words of
// other people's post.
// ---------------------------------------------------------------------------

export type ArrivalsQuery =
  /** Everything that reached the site since the browser last asked. */
  | { kind: 'since'; since: Date }
  /** These conversations, which a collection has just filed something into. */
  | { kind: 'threads'; threadIds: string[] }

/** Where nudges point, worked out once per round rather than once per
 *  conversation: the admin area's address comes from the site's settings. */
export async function nudgeLinks(): Promise<{ base: string; listHref: string; icon: string }> {
  const base = inboxBase(await getAdminPathCached())
  return { base, listHref: listHrefFor(base), icon: BRANDING_DEFAULTS.icon512 }
}

export async function arrivalsFor(
  user: SessionUser,
  query: ArrivalsQuery,
  now: Date,
  links: { base: string },
): Promise<Pick<ArrivalsReply, 'arrivals' | 'total'>> {
  const none = { arrivals: [], total: 0 }
  if (user.suspendedAt) return none
  if (!await hasPermission(user, 'unifiedinbox.view')) return none
  if (query.kind === 'threads' && query.threadIds.length === 0) return none

  // Every address they may read: their own, the shared ones they are on, and
  // the colleagues' they have been let into - the Yours, Shared and Team
  // inboxes sections of the rail, which draw on this same list. Mail that
  // landed in no address at all, and the channels another module owns, stay
  // out: neither is anybody's post.
  const allInboxes = await listInboxes()
  const visibleIds = await visibleInboxIds(user, allInboxes.map((i) => i.id))
  if (visibleIds.length === 0) return none
  const names = new Map(allInboxes.map((inbox) => [inbox.id, inbox.name]))
  const visible = new Set(visibleIds)

  const filters: ThreadListFilters = {
    viewerUserId: user.id,
    inboxIds: visibleIds,
    includeUnrouted: false,
    providerModules: [],
    inboxId: null,
    unreadOnly: true,
    // Waiting, rather than merely not opened. Something set aside until
    // Thursday is not news on Tuesday, and something finished with is not news
    // at all.
    status: 'open',
    arrivedSince: {
      since: query.kind === 'since' ? query.since : new Date(now.getTime() - MAX_ARRIVAL_AGE_MS),
      writtenAfter: new Date(now.getTime() - MAX_ARRIVAL_AGE_MS),
    },
    threadIds: query.kind === 'threads' ? query.threadIds : null,
    page: 1,
    // One over the cap, so an ordinary round can tell "that is all of them"
    // from "there are more" without paying for a second query to count them.
    perPage: MAX_ARRIVALS + 1,
  }

  const rows = await listThreads(filters)
  const arrivals: Arrival[] = rows.slice(0, MAX_ARRIVALS).map((row) => {
    // Named and linked by the address it is filed under, when the reader may
    // see that address - or else by one of the others it belongs to (a merge,
    // or copied-in mail) that they can. A conversation across two addresses
    // shows to somebody who can read either, and naming the one they cannot
    // would be telling them it exists.
    const inboxId = [row.inboxId, ...row.absorbedInboxIds].find((id): id is string => !!id && visible.has(id)) ?? null
    return {
      threadId: row.id,
      subject: row.subject,
      from: row.participantName ?? row.participantAddress,
      at: (row.lastMessageAt ?? now).toISOString(),
      inbox: inboxId ? names.get(inboxId) ?? null : null,
      href: threadHrefFor(links.base, row.id, inboxId),
    }
  })

  // Past the cap it is worth knowing how many there really were: "6 new
  // messages" when there are ninety is the sort of small untruth that stops
  // people trusting the number at all. Only then, though - a busy morning is
  // rare and an ordinary round pays nothing for it.
  const total = rows.length > MAX_ARRIVALS ? await countThreads(filters) : rows.length
  return { arrivals, total }
}
