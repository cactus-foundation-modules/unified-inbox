import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { visibleInboxIds } from '@/modules/unified-inbox/lib/access'
import {
  countThreads,
  defaultInboxIdFor,
  getSettings,
  listInboxes,
  listThreads,
  type ThreadListFilters,
} from '@/modules/unified-inbox/lib/db'
import { MAX_ARRIVALS, parseSince, type Arrival, type ArrivalsReply } from '@/modules/unified-inbox/lib/notify'
import { visibleProviderChannels } from '@/modules/unified-inbox/lib/provider-registry'

// "Has anything landed since you last asked?", for the browser to nudge
// somebody with. See lib/notify.ts for the whole of the reasoning; this is the
// half of it that touches the database.
//
// THE ACCESS RULE RUNS THROUGH IT UNCHANGED (E17). The inboxes this person may
// read are resolved and passed INTO the query, exactly as the screen itself
// does, so a subject line from accounts@ can no more reach somebody through a
// notification than it can through the list. That is the whole reason this is a
// route of its own rather than a count bolted onto something general: it hands
// out the words of other people's post.
//
// It is asked ONLY by a browser whose window is behind something else, and only
// by somebody who has turned nudges on. A tab in front of a reader refreshes
// its own list and asks this nothing.

async function empty(now: Date): Promise<Response> {
  return NextResponse.json({ now: now.toISOString(), arrivals: [], total: 0 } satisfies ArrivalsReply)
}

export async function GET(request: Request) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.view')) return errorResponse('Forbidden', 403)

  // Read before the query rather than after it. Anything that lands while this
  // round is running has an instant later than this one and is therefore still
  // new next time, which is the failure worth avoiding. The other way round, a
  // message arriving in that same fraction of a second would be skipped for
  // good - and a nudge that never comes is not a bug anybody can see.
  const now = new Date()
  const since = parseSince(new URL(request.url).searchParams.get('since'), now.getTime())

  // No mark yet: the browser is only asking what the time is, so that the round
  // AFTER this one has something honest to measure from. Answered without
  // touching the conversations at all.
  if (!since) return empty(now)

  const canManage = await hasPermission(user, 'unifiedinbox.manage')
  const allInboxes = await listInboxes()
  const visibleIds = await visibleInboxIds(user, allInboxes.map((i) => i.id))

  // Their own address, when they have one they may still read - resolved the
  // same way the screen resolves it, and for the same reason: an address can be
  // taken off somebody's guest list long after it was made theirs.
  const ownInboxId = await defaultInboxIdFor(user.id)
  const pinned = ownInboxId && visibleIds.includes(ownInboxId) ? ownInboxId : null

  // Somebody with an address of their own is nudged about that and nothing
  // else: they asked for their post, not for the building's. Somebody without
  // one is nudged about everything they may read, channels included, because
  // for them that IS their mailbox - and the channels are narrowed to the ones
  // the rail shows, so the nudges and the numbers beside them agree.
  let channelModules: string[] = []
  if (!pinned) {
    const hidden = new Set((await getSettings()).hiddenChannelModules)
    channelModules = (await visibleProviderChannels(user))
      .map((channel) => channel.key)
      .filter((key) => !hidden.has(key))
  }

  const inboxIds = pinned ? [pinned] : visibleIds
  const includeUnrouted = pinned ? false : canManage
  // Nothing this person may read at all. Asking the database to prove that
  // again every minute helps nobody.
  if (inboxIds.length === 0 && channelModules.length === 0 && !includeUnrouted) return empty(now)

  const filters: ThreadListFilters = {
    viewerUserId: user.id,
    inboxIds,
    includeUnrouted,
    providerModules: channelModules,
    inboxId: pinned,
    unreadOnly: true,
    // Waiting, rather than merely not opened. Something set aside until
    // Thursday is not news on Tuesday, and something finished with is not news
    // at all.
    status: 'open',
    after: since,
    page: 1,
    // One over the cap, so an ordinary round can tell "that is all of them"
    // from "there are more" without paying for a second query to count them.
    perPage: MAX_ARRIVALS + 1,
  }

  const rows = await listThreads(filters)
  const arrivals: Arrival[] = rows.slice(0, MAX_ARRIVALS).map((row) => ({
    threadId: row.id,
    subject: row.subject,
    from: row.participantName ?? row.participantAddress,
    at: (row.lastMessageAt ?? now).toISOString(),
  }))

  // Past the cap it is worth knowing how many there really were: "6 new
  // messages" when there are ninety is the sort of small untruth that stops
  // people trusting the number at all. Only then, though - a busy morning is
  // rare and an ordinary round pays nothing for it.
  const total = rows.length > MAX_ARRIVALS ? await countThreads(filters) : rows.length

  return NextResponse.json({ now: now.toISOString(), arrivals, total } satisfies ArrivalsReply)
}
