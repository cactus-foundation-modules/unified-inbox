import type { MediaProviderType } from '@prisma/client'
import { deleteMedia } from '@/lib/media/upload'
import {
  deleteThreads,
  failStalledSends,
  getSettings,
  markRetentionRun,
  pruneOrphanOrganisations,
  pruneOrphanPeople,
  retentionDueCounts,
  storedObjectsForThreads,
  threadsDueForRetention,
} from './db'

// ---------------------------------------------------------------------------
// Retention, and the housekeeping that keeps a mailbox liveable for years.
//
// This is the only thing in the module that removes a customer's own words, so
// it is deliberately the most cautious code in it:
//
//   It does nothing at all unless the owner has set a window. Blank means keep
//   everything, which is the state every site starts in.
//
//   A conversation carrying a link to one of the site's own records - an order,
//   a purchase order, a quote - is kept whatever its age, unless the owner has
//   turned that off. Somebody who typed "12" was thinking about mailing lists,
//   not about the correspondence behind an invoice dispute from eighteen months
//   ago, and the two look identical to a date comparison.
//
//   It works in small batches against a deadline, like everything else on the
//   hourly tick, and every batch is committed before the next starts. A site
//   with ten years of mail and a twelve month window takes many ticks to catch
//   up, and that is the design.
//
//   The stored bytes go BEFORE the rows do. An interrupted sweep then leaves an
//   object in storage with nothing pointing at it - which the storage check
//   finds and offers up - rather than a row pointing at bytes that have gone.
// ---------------------------------------------------------------------------

/** Conversations considered per pass. Small: each one costs a delete that
 *  cascades across messages and attachments, and the tick has other work. */
export const RETENTION_BATCH = 50

/** How long a message may sit in 'sending' before we call it interrupted. A
 *  send is a single request with a 60 second ceiling, so anything older than
 *  this crashed rather than being slow. */
export const STALLED_SEND_MS = 15 * 60 * 1000

/** People and organisations tidied per pass, once their conversations have gone. */
export const PRUNE_BATCH = 200

/**
 * The date a conversation must be older than to be swept. Pure, so the settings
 * screen and the sweep itself can never disagree about where the line falls.
 * Null means the owner has not set a window and nothing is ever removed.
 */
export function retentionCutoff(retentionMonths: number | null, now: Date): Date | null {
  if (retentionMonths === null || !Number.isFinite(retentionMonths) || retentionMonths <= 0) return null
  const cutoff = new Date(now.getTime())
  cutoff.setMonth(cutoff.getMonth() - Math.floor(retentionMonths))
  return cutoff
}

/**
 * Messages written down as 'sending' whose send never came back. That is a
 * crash between the row and the network call, and left alone it sits in a
 * conversation for ever saying "sending", with nobody able to tell whether the
 * customer received it.
 *
 * This one runs on the HOURLY tick rather than with the rest of the sweep,
 * because an hour is about as long as anybody should have to look at that. It
 * costs a single update against a partial index that holds only the rows
 * currently in flight, which on any ordinary site is none of them.
 */
export async function sweepStalledSends(now = new Date()): Promise<number> {
  return failStalledSends(new Date(now.getTime() - STALLED_SEND_MS))
}

export type RetentionOutcome = {
  /** False when no window is set, which is not a failure. */
  ran: boolean
  conversations: number
  storedObjects: number
  storedObjectFailures: number
  people: number
  organisations: number
  /** True when the batch filled up, so there is more waiting for the next run. */
  more: boolean
}

const EMPTY: RetentionOutcome = {
  ran: false,
  conversations: 0,
  storedObjects: 0,
  storedObjectFailures: 0,
  people: 0,
  organisations: 0,
  more: false,
}

/**
 * One pass of the retention sweep. Runs on its own daily job rather than on the
 * mail tick: the hourly slice is already spoken for by collection, the channels
 * and the people pass, and removing a year-old conversation eleven hours later
 * than it might have been costs nothing at all.
 */
export async function sweepRetention(opts: { deadline: number; now?: Date } = { deadline: Date.now() + 18_000 }): Promise<RetentionOutcome> {
  const now = opts.now ?? new Date()
  const outcome: RetentionOutcome = { ...EMPTY }

  const settings = await getSettings()
  const cutoff = retentionCutoff(settings.retentionMonths, now)
  if (!cutoff) return outcome
  outcome.ran = true

  const candidates = await threadsDueForRetention(cutoff, settings.retentionKeepLinked, RETENTION_BATCH)
  outcome.more = candidates.length === RETENTION_BATCH
  if (candidates.length > 0) {
    const ids = candidates.map((c) => c.id)

    // Bytes first. A failure here is logged and carried: the object becomes an
    // orphan the storage check can offer up, which is recoverable, whereas
    // keeping the row because storage was briefly unreachable means the window
    // silently stops working.
    const objects = await storedObjectsForThreads(ids)
    for (const object of objects) {
      if (Date.now() > opts.deadline) break
      try {
        await deleteMedia(object.mediaProvider as MediaProviderType, object.mediaKey)
        outcome.storedObjects += 1
      } catch (err) {
        outcome.storedObjectFailures += 1
        console.warn('[unified-inbox] retention could not remove a stored attachment:', err)
      }
    }

    outcome.conversations = await deleteThreads(ids)
  }

  if (Date.now() < opts.deadline) {
    // Whoever those conversations belonged to, if they are now holding nothing
    // and nobody ever typed anything about them. A name or a note is somebody's
    // own work and is never swept (E8's other half).
    outcome.people = await pruneOrphanPeople(PRUNE_BATCH)
    outcome.organisations = await pruneOrphanOrganisations(PRUNE_BATCH)
  }

  await markRetentionRun()
  return outcome
}

/** What the settings screen shows beside the window box, so the owner can see
 *  what turning it on would do before they turn it on. */
export async function retentionPreview(now = new Date()): Promise<{
  cutoff: Date | null
  due: number
  keptForLinks: number
} | null> {
  const settings = await getSettings()
  const cutoff = retentionCutoff(settings.retentionMonths, now)
  if (!cutoff) return null
  const counts = await retentionDueCounts(cutoff)
  return {
    cutoff,
    due: settings.retentionKeepLinked ? counts.due - counts.linked : counts.due,
    keptForLinks: settings.retentionKeepLinked ? counts.linked : 0,
  }
}
