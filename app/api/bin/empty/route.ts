// POST /api/m/unified-inbox/bin/empty - throw away, for good, everything in one
// person's bin.
//
// ---------------------------------------------------------------------------
// THIS IS THE ONE ROUTE IN THIS MODULE THAT DESTROYS A CUSTOMER'S WORDS ON
// PURPOSE, AT A PERSON'S REQUEST. Everything else refuses, hides or moves.
// Retention destroys too, but on a window the owner set months ago and never on
// a press. So this file is written the way lib/retention.ts is written: the
// most cautious code in the module, with every step said out loud.
//
// What it does NOT do, and must never do:
//
//   It does not touch a mail server. The messages stay exactly where they are
//   in whatever mailbox they were collected from. This module has only ever
//   written one thing to anybody's mailbox - a copy of a reply, filed in Sent -
//   and emptying a bin on this site is a fact about this site. Whoever presses
//   the button still has every message in their own mail account, which is
//   worth knowing before anybody adds an IMAP delete here in a tidy mood.
//
//   It does not empty on a timer. Nothing calls this but the button, and the
//   button asks first. See migration 052 for why the absence of a thirty-day
//   sweep is a decision rather than an omission.
//
//   It does not take a list of conversations from the browser. The ids are
//   worked out here, from the same two clauses the folder itself is drawn from,
//   because a body that could name conversations could name any conversation
//   (E17).
//
// WHOSE BIN is named by ADDRESS rather than by person, and resolved against the
// addresses this reader may actually open - `bin:<inbox id>` is what the folder
// under a colleague's name on the rail already says, and an id that does not
// resolve empties nothing at all rather than falling back to the reader's own.
//
// THE GRANT IS `manage`, which is stricter than the grant to fill a bin, and
// deliberately so. Anybody who may read a conversation may delete it, because
// that hides it from their own screen and puts back with the same press.
// Emptying is different in kind: the conversation goes for EVERYBODY who could
// see it - a shared address has several readers, and the row is the site's, not
// one person's - and nothing brings it back. That is the same line the rest of
// the module draws around merges, which change who can read what and take the
// same grant.
//
// BYTES BEFORE ROWS, exactly as retention does it. An interrupted empty then
// leaves an object in storage with nothing pointing at it - which the storage
// check finds and offers up - rather than a row pointing at bytes that have
// gone.
//
// AND IT WORKS TO A DEADLINE, for the same reason. A bin with four thousand
// attachments in it is four thousand requests to storage, which is comfortably
// more than one request has. Run out of time and the run stops WHERE IT IS -
// having finished whole batches - and says so, so the button can be pressed
// again for the rest. The failure mode this shape rules out is the one that
// matters: a request killed halfway between "deleted the bytes" and "deleted
// the rows" would leave conversations on the screen whose attachments had
// silently gone. Each batch here does both, so the two never come apart by
// more than one batch.
// ---------------------------------------------------------------------------
import { NextRequest, NextResponse } from 'next/server'
import type { MediaProviderType } from '@prisma/client'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { releaseStoredObject } from '@/modules/unified-inbox/lib/attachment-filing'
import { errorResponse } from '@/lib/utils'
import { visibleInboxIds } from '@/modules/unified-inbox/lib/access'
import {
  binThreadIds,
  deleteThreads,
  getSettings,
  listInboxes,
  storedObjectsForThreads,
} from '@/modules/unified-inbox/lib/db'
import { visibleProviderChannels } from '@/modules/unified-inbox/lib/provider-registry'
import { EmptyBinBody } from '@/modules/unified-inbox/lib/validation'

export const maxDuration = 60

/** Conversations destroyed per batch. Small enough that one batch is a handful
 *  of seconds even when every conversation carries a file, so the deadline
 *  below stops between batches rather than inside one. */
const BATCH = 100

/** When to stop and say there is more. Well inside `maxDuration`, because the
 *  answer still has to be written and read. */
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

  // Whose bin. Their own where no address was named; otherwise the owner of the
  // address, and only where the reader may open it and it belongs to somebody.
  // A shared address has no bin - the junk and the deletions made in one land in
  // the presser's own folder - so naming one here is a request that cannot mean
  // anything, and it is refused rather than quietly turned into the reader's own
  // bin, which would empty the wrong thing on a mistyped address.
  let ownerUserId = user.id
  if (askedFor !== null) {
    const inbox = visibleIds.includes(askedFor)
      ? allInboxes.find((i) => i.id === askedFor) ?? null
      : null
    if (!inbox || inbox.kind !== 'individual' || !inbox.ownerUserId) {
      return errorResponse('That is not a bin you can empty.', 404)
    }
    ownerUserId = inbox.ownerUserId
  }

  // Exactly what the folder shows, and nothing behind it. The rail's channel
  // list is narrowed by whatever the site has switched off, so the same
  // narrowing is applied here: a button that says "Empty" and destroys three
  // conversations the reader was never shown is a button that has lied.
  const settings = await getSettings()
  const hidden = new Set(settings.hiddenChannelModules)
  const channelModules = (await visibleProviderChannels(user))
    .map((channel) => channel.key)
    .filter((key) => !hidden.has(key))

  const ids = await binThreadIds({
    ownerUserId,
    inboxIds: visibleIds,
    // `manage` is already established above, which is the same test the panel
    // uses to decide whether unfiled post is this reader's to see.
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

    // The bytes first. A failure here is carried rather than fatal, for
    // retention's reason: the object becomes an orphan the storage check can
    // offer up, which is recoverable, whereas keeping the conversation because
    // storage was briefly unreachable means a bin that will not empty and a
    // person pressing the button over and over.
    for (const object of await storedObjectsForThreads(batch)) {
      try {
        await releaseStoredObject(object)
        storedObjects += 1
      } catch (err) {
        storedObjectFailures += 1
        console.warn('[unified-inbox] emptying a bin could not remove a stored attachment:', err)
      }
    }

    // And the conversations. Messages, attachment rows, events, links, junk
    // marks and the bin rows themselves go with them by cascade; the location
    // ledger keeps its row with a null conversation, which is what stops the
    // next collection fetching the very post somebody has just thrown away and
    // filing it as new. See deleteThreads.
    conversations += await deleteThreads(batch)
  }

  return NextResponse.json({ ok: true, conversations, storedObjects, storedObjectFailures, more })
}
