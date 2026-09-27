import { prisma } from '@/lib/db/prisma'
import { getSiteUrlOrNull } from '@/lib/config/env'
import { arrivalsFor, nudgeLinks } from './arrivals'
import { MAX_ARRIVAL_AGE_MS, nudgeFor } from './notify'
import { claimArrivals, forgetEndpoint, listSubscriptions, readVapidKeys, type StoredSubscription } from './push-db'
import { sendWebPush } from './web-push'

// ---------------------------------------------------------------------------
// The site telling browsers about new post the moment it has collected some.
//
// Run at the end of every collection - the hourly job, Check now, the admin
// page's own timer and a provider ringing - so a message is announced by
// whichever of them filed it, within seconds of it being filed. See
// lib/notify.ts for whose post counts and lib/web-push.ts for the protocol.
//
// Never throws. A push service having a bad afternoon is no reason for mail
// collection to report a failure; it is logged and the round moves on.
// ---------------------------------------------------------------------------

/** How long a round may take, at most. Sending is one short POST per browser,
 *  so this is a ceiling for a bad day rather than the time an ordinary round
 *  takes. */
export const NUDGE_BUDGET_MS = 5_000

/** How far back a round looks for mail nobody has claimed yet. Every collection
 *  runs a round once it has filed its mail, so anything a round misses is a
 *  message committed while it was looking, and the next round - minutes away
 *  at most while anybody has the admin area open - picks it up. Half an hour
 *  covers that with a wide margin and stops a site that has not collected for
 *  a day from announcing it all when it does. */
const CLAIM_WINDOW_MS = 30 * 60_000

/** How long a push service should hold a nudge for a browser that is offline:
 *  a laptop closed over lunch still hears about the morning's post when it is
 *  opened, and one closed over the weekend does not get Friday's on Monday. */
const NUDGE_TTL_S = 4 * 60 * 60

/** The most one browser's push service is waited on. */
const SEND_TIMEOUT_MS = 4_000

export type NudgeRound = {
  /** Conversations something new was claimed in. */
  conversations: number
  /** People there was something to tell. */
  people: number
  sent: number
  failed: number
  /** Browsers the push service said are gone for good, and forgotten. */
  gone: number
}

/**
 * Who the site says it is to the push services. Apple refuses a send without
 * one, and it has to be an https: address or a mailto:, so a site whose own
 * address is not https (a laptop on localhost) sends nothing.
 */
function vapidSubject(): string | null {
  const site = getSiteUrlOrNull()
  return site && site.startsWith('https://') ? site : null
}

function groupByUser(subscriptions: StoredSubscription[]): Map<string, StoredSubscription[]> {
  const byUser = new Map<string, StoredSubscription[]>()
  for (const sub of subscriptions) {
    const list = byUser.get(sub.userId)
    if (list) list.push(sub)
    else byUser.set(sub.userId, [sub])
  }
  return byUser
}

export async function sendPushNudges(opts: { deadline: number }): Promise<NudgeRound> {
  const round: NudgeRound = { conversations: 0, people: 0, sent: 0, failed: 0, gone: 0 }
  try {
    const now = new Date()
    const threadIds = await claimArrivals(
      new Date(now.getTime() - CLAIM_WINDOW_MS),
      new Date(now.getTime() - MAX_ARRIVAL_AGE_MS),
    )
    round.conversations = threadIds.length
    if (threadIds.length === 0) return round

    const subscriptions = await listSubscriptions()
    if (subscriptions.length === 0) return round
    // No pair means nobody can have subscribed with one, whatever the table
    // says - and never MADE here: a pair minted by a round nobody asked for
    // would strand every subscription bound to the one that went missing.
    const keys = await readVapidKeys()
    if (!keys) return round
    const subject = vapidSubject()
    if (!subject) {
      console.warn('[unified-inbox] new-mail nudges need SITE_URL to be an https address; none sent')
      return round
    }

    const links = await nudgeLinks()
    const byUser = groupByUser(subscriptions)
    const users = await prisma.user.findMany({
      where: { id: { in: [...byUser.keys()] }, suspendedAt: null },
      include: { role: true },
    })

    for (const user of users) {
      if (Date.now() >= opts.deadline) break
      const found = await arrivalsFor(user, { kind: 'threads', threadIds }, now, links)
      const nudge = nudgeFor({ ...found, listHref: links.listHref, icon: links.icon })
      if (!nudge) continue
      round.people++
      const payload = JSON.stringify(nudge)
      // Every browser this person has said yes in, at once: their laptop and
      // their phone are told together, which is the point of having both.
      await Promise.all((byUser.get(user.id) ?? []).map(async (sub) => {
        try {
          const outcome = await sendWebPush(sub, payload, { keys, subject }, {
            ttlSeconds: NUDGE_TTL_S,
            urgency: 'high',
            timeoutMs: Math.max(1_000, Math.min(SEND_TIMEOUT_MS, opts.deadline - Date.now())),
          })
          if (outcome.ok) {
            round.sent++
          } else if (outcome.gone) {
            round.gone++
            await forgetEndpoint(sub.endpoint)
          } else {
            round.failed++
            console.warn('[unified-inbox] a push service refused a new-mail nudge', {
              status: outcome.status,
              service: new URL(sub.endpoint).hostname,
            })
          }
        } catch (err) {
          round.failed++
          console.warn('[unified-inbox] a new-mail nudge could not be sent', {
            service: new URL(sub.endpoint).hostname,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }))
    }
  } catch (err) {
    console.error('[unified-inbox] the new-mail nudge round failed', err)
  }
  return round
}
