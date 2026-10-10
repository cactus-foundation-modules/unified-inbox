// POST /api/m/unified-inbox/spam/empty - delete, for good, everything in one
// person's junk folder.
//
// The Bin's emptying route (../../bin/empty) with a different folder, and
// everything it says about care applies here word for word: bytes before rows,
// a deadline that stops between whole batches, the ids worked out on the server
// from the same clauses the folder is drawn from and never taken from the
// browser, `manage` rather than `view` because the conversations go for
// everybody who could read them, and no mail server touched - the post stays in
// whatever mailbox it was collected from.
//
// One difference worth saying: the sender stays blocked. Deleting what a blocked
// address sent is not lifting the block, and a deleted conversation leaves its
// location-ledger row behind, so the next collection does not fetch it again and
// file it as new.
import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { releaseStoredObject } from '@/modules/unified-inbox/lib/attachment-filing'
import { errorResponse } from '@/lib/utils'
import { visibleInboxIds } from '@/modules/unified-inbox/lib/access'
import {
  deleteThreads,
  getSettings,
  listInboxes,
  spamThreadIds,
  storedObjectsForThreads,
} from '@/modules/unified-inbox/lib/db'
import { visibleProviderChannels } from '@/modules/unified-inbox/lib/provider-registry'
import { EmptyBinBody } from '@/modules/unified-inbox/lib/validation'

export const maxDuration = 60

/** Conversations destroyed per batch - see the bin's route. */
const BATCH = 100

/** When to stop and say there is more. */
const BUDGET_MS = 45_000

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'unifiedinbox.manage'))) return errorResponse('Forbidden', 403)

  const parsed = EmptyBinBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That does not look right.', 400)
  const askedFor = parsed.data.inboxId ?? null

  const allInboxes = await listInboxes()
  const visibleIds = await visibleInboxIds(user, allInboxes.map((i) => i.id))

  // Whose junk: their own where no address was named, otherwise the owner of an
  // individual address the reader may open. A shared address has no junk of its
  // own (it lands in the presser's), so naming one is refused rather than
  // quietly turned into the reader's own folder.
  let ownerUserId = user.id
  if (askedFor !== null) {
    const inbox = visibleIds.includes(askedFor)
      ? allInboxes.find((i) => i.id === askedFor) ?? null
      : null
    if (!inbox || inbox.kind !== 'individual' || !inbox.ownerUserId) {
      return errorResponse('That is not a junk folder you can empty.', 404)
    }
    ownerUserId = inbox.ownerUserId
  }

  // The same narrowing the rail applies, so the button never destroys what the
  // folder was not showing.
  const settings = await getSettings()
  const hidden = new Set(settings.hiddenChannelModules)
  const channelModules = (await visibleProviderChannels(user))
    .map((channel) => channel.key)
    .filter((key) => !hidden.has(key))

  const ids = await spamThreadIds({
    ownerUserId,
    viewerUserId: user.id,
    inboxIds: visibleIds,
    includeUnrouted: true,
    providerModules: channelModules,
  })
  if (ids.length === 0) {
    return NextResponse.json({ ok: true, conversations: 0, storedObjects: 0, storedObjectFailures: 0, more: false })
  }

  const deadline = Date.now() + BUDGET_MS
  let conversations = 0
  let storedObjects = 0
  let storedObjectFailures = 0
  let more = false

  for (let at = 0; at < ids.length; at += BATCH) {
    if (Date.now() > deadline) { more = true; break }
    const batch = ids.slice(at, at + BATCH)

    // Bytes first: a failure is carried, not fatal, so the object becomes an
    // orphan the storage check can offer up rather than the folder refusing to
    // empty.
    for (const object of await storedObjectsForThreads(batch)) {
      try {
        await releaseStoredObject(object)
        storedObjects += 1
      } catch (err) {
        storedObjectFailures += 1
        console.warn('[unified-inbox] emptying junk could not remove a stored attachment:', err)
      }
    }

    conversations += await deleteThreads(batch)
  }

  return NextResponse.json({ ok: true, conversations, storedObjects, storedObjectFailures, more })
}
