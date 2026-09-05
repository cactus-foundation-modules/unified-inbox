import { calendarDateIn, instantAtWallClock } from '@/lib/config/timezone'
import { getSiteTimezone } from '@/lib/config/timezone.server'
import { getSiteEmailContext } from '@/lib/email/render'
import { getInbox, getSettings } from '../db'
import { generateMessageId } from '../compose'
import { buildRawMessage } from '../mime'
import { appendToSent } from '../append'
import { deliver, transportForInbox } from '../transport'
import { bounceVerdict, dayIsFull, isCampaignWideFailure } from './guards'
import { buildCampaignMessage } from './message'
import { addSuppression, isSuppressed } from './store'
import {
  abandonLane,
  advanceRecipient,
  campaignTally,
  claimLane,
  claimNextRecipient,
  hasRepliedSince,
  laneNextSendAt,
  listRunnableCampaigns,
  listSteps,
  releaseLane,
  releaseStaleRecipientClaims,
  requeueRecipient,
  sendStats,
  sentBetween,
  sendingDayNumber,
  setCampaignStatus,
  setRecipientState,
  settleSend,
  startSend,
  sweepReplies,
} from './store'
import { gapAfterSend, isInsideWindow, nextSlot, rampCapForDay } from './window'
import type { Campaign, CampaignRecipient, CampaignStep } from './types'

// ---------------------------------------------------------------------------
// The engine: one tick's worth of campaign sending.
//
// It is called from three places and behaves identically in all three - the
// site's hourly round, the Campaigns screen while somebody has it open, and
// whatever minute-by-minute pinger the site has been pointed at the tick
// address. There is no "manual" path with different rules, because a second
// path is a second set of bugs and the second one always sends the duplicate.
//
// NOTHING SLEEPS IN HERE. A serverless function waiting ninety seconds between
// two emails is ninety seconds of somebody's hosting bill spent doing nothing,
// so the gap is kept in the database - the lane's next_send_at - and a tick
// that arrives too early simply sends nothing and returns. The pace therefore
// comes from how often the tick arrives, which is why the screen says out loud
// which clock is driving it.
//
// CATCHING UP IS BOUNDED. On an hourly round the lane can be an hour behind,
// and firing forty emails to make up the difference is precisely the burst the
// ninety second gap exists to avoid. So a run may make up at most a handful,
// and the rest of the debt is simply forgotten: a campaign that runs slower
// than planned is a campaign that finishes later, which is a disappointment.
// A campaign that empties an hour's backlog into one second is a campaign that
// gets the domain blocked, which is a catastrophe.
// ---------------------------------------------------------------------------

/** How long a run will keep starting sends. Short of the dispatcher's own 25
 *  second slice, so a run finishes the message it is on and returns rather
 *  than being cut off part way through one. */
export const CAMPAIGN_BUDGET_MS = 18_000

/** The most one run will send from one address, however far behind it is. */
export const MAX_SENDS_PER_RUN = 5

/** How long a claim may sit unsettled before it is taken to be a run that died.
 *  Nothing was sent under it - the send row is written first - so putting it
 *  back cannot produce a duplicate. */
export const STALE_CLAIM_MS = 10 * 60_000

/** How many recipients each tick checks for replies beyond the ones it is about
 *  to write to. Small: the per-recipient check at chase time is the one that
 *  decides anything, and this is only so the screen is up to date. */
const REPLY_SWEEP = 25

export type CampaignRunResult = {
  /** Claims from a run that died, put back. */
  released: number
  sent: number
  failed: number
  /** People taken out of the queue without being written to - suppressed since
   *  the list was built, or they replied while it was waiting. */
  skipped: number
  replied: number
  campaigns: number
  /** True when there was still work in hand when the clock ran out. */
  moreDue: boolean
}

export async function runDueCampaigns(options?: {
  now?: Date
  deadline?: number
}): Promise<CampaignRunResult> {
  const now = options?.now ?? new Date()
  const deadline = options?.deadline ?? Date.now() + CAMPAIGN_BUDGET_MS

  const result: CampaignRunResult = {
    released: 0, sent: 0, failed: 0, skipped: 0, replied: 0, campaigns: 0, moreDue: false,
  }

  // Cheaply first: anything a previous run took and never settled.
  result.released = await releaseStaleRecipientClaims(new Date(now.getTime() - STALE_CLAIM_MS))

  const campaigns = await listRunnableCampaigns(now)
  if (campaigns.length === 0) return result

  const [timezone, settings, site] = await Promise.all([
    getSiteTimezone(),
    getSettings(),
    getSiteEmailContext(),
  ])

  for (const campaign of campaigns) {
    if (Date.now() > deadline) {
      result.moreDue = true
      break
    }
    result.campaigns += 1
    // Replies first, so somebody who wrote back this morning is not chased this
    // afternoon and the screen says so either way.
    result.replied += await sweepReplies(campaign.id, REPLY_SWEEP)

    const outcome = await runOneCampaign(campaign, {
      now,
      deadline,
      timezone,
      siteName: site.siteName,
      postalAddress: settings.campaignFooterAddress,
      trackOpens: settings.trackOpens,
    })
    result.sent += outcome.sent
    result.failed += outcome.failed
    result.skipped += outcome.skipped
    if (outcome.moreDue) result.moreDue = true
  }

  return result
}

type RunContext = {
  now: Date
  deadline: number
  timezone: string
  siteName: string
  postalAddress: string | null
  trackOpens: boolean
}

async function runOneCampaign(
  campaign: Campaign,
  ctx: RunContext,
): Promise<{ sent: number; failed: number; skipped: number; moreDue: boolean }> {
  const idle = { sent: 0, failed: 0, skipped: 0, moreDue: false }

  // The address it sends from, which somebody may have deleted since.
  if (!campaign.inboxId) {
    await setCampaignStatus(campaign.id, 'paused', {
      pauseKind: 'address-gone',
      pauseReason: 'The address this was sending from has been removed, so it has stopped. '
        + 'Choose another address and start it again.',
    })
    return idle
  }
  const inbox = await getInbox(campaign.inboxId)
  if (!inbox) {
    await setCampaignStatus(campaign.id, 'paused', {
      pauseKind: 'address-gone',
      pauseReason: 'The address this was sending from is no longer here, so it has stopped.',
    })
    return idle
  }

  // Is anybody left at all? Asked before the window, so a campaign that finished
  // overnight is marked finished the next time anything looks rather than
  // waiting until nine in the morning to notice.
  const tally = await campaignTally(campaign.id)
  if (tally.queued === 0 && tally.sending === 0) {
    await setCampaignStatus(campaign.id, 'done', { finishedAt: ctx.now })
    return idle
  }

  // Outside working hours, at a weekend, or on a day it was told to sit out.
  if (!isInsideWindow(ctx.now, campaign.window, ctx.timezone)) return { ...idle, moreDue: true }

  // The day's allowance, warm-up and all.
  const dayStart = instantAtWallClock(calendarDateIn(ctx.now, ctx.timezone), '00:00', ctx.timezone)
  const dayEnd = new Date(dayStart.getTime() + 86_400_000)
  const sentToday = await sentBetween(campaign.id, dayStart, dayEnd)
  const dayNumber = await sendingDayNumber(campaign.id, ctx.timezone)
  const allowance = rampCapForDay(dayNumber, campaign.window)
  if (dayIsFull(sentToday, allowance)) return { ...idle, moreDue: true }

  // How far behind the address's own clock is, which decides how many this run
  // may make up. Read before the claim, because claiming moves it.
  const laneDue = await laneNextSendAt(campaign.inboxId)
  const behindMs = laneDue ? ctx.now.getTime() - laneDue.getTime() : 0
  const missed = behindMs > 0 ? Math.floor(behindMs / (campaign.window.intervalSeconds * 1000)) : 0
  let allowed = Math.min(1 + Math.max(0, missed), MAX_SENDS_PER_RUN)
  if (allowance !== null) allowed = Math.min(allowed, allowance - sentToday)

  const claimed = await claimLane(
    campaign.inboxId,
    ctx.now,
    new Date(ctx.now.getTime() - STALE_CLAIM_MS),
  )
  // Another run has the address, or its clock has not come round. Both are
  // ordinary answers: the next tick tries again.
  if (!claimed) return { ...idle, moreDue: true }

  const steps = await listSteps(campaign.id)
  let sent = 0
  let failed = 0
  let skipped = 0
  let sentSomething = false

  try {
    while (sent < allowed && Date.now() < ctx.deadline) {
      const recipient = await claimNextRecipient(campaign.id, ctx.now)
      if (!recipient) break

      const verdict = await sendToRecipient(recipient, { campaign, steps, inbox, ctx })
      if (verdict.kind === 'sent') {
        sent += 1
        sentSomething = true
      } else if (verdict.kind === 'failed') {
        failed += 1
        sentSomething = true
      } else if (verdict.kind === 'skipped') {
        skipped += 1
        // A skip costs no gap: nothing left the building, so the next person is
        // not made to wait ninety seconds for somebody who unsubscribed a
        // fortnight ago.
        continue
      } else if (verdict.kind === 'paused') {
        break
      }

      // The bounce guard, asked after every send rather than once a day: the
      // whole value of it is stopping in the first hundred rather than the
      // first thousand.
      const stats = await sendStats(campaign.id)
      const bounces = bounceVerdict(stats.sent, stats.hardBounces)
      if (bounces.pause) {
        await setCampaignStatus(campaign.id, 'paused', {
          pauseKind: 'bounces',
          pauseReason: bounces.reason,
        })
        break
      }
    }
  } finally {
    if (sentSomething) {
      const gap = gapAfterSend(campaign.window) * 1000
      const earliest = new Date(Date.now() + gap)
      // Never inside a closed window: the next one goes when the doors open,
      // not at two in the morning because the gap happened to land there.
      const next = nextSlot(earliest, campaign.window, ctx.timezone) ?? earliest
      await releaseLane(campaign.inboxId, next)
    } else {
      await abandonLane(campaign.inboxId)
    }
  }

  return { sent, failed, skipped, moreDue: true }
}

type SendVerdict =
  | { kind: 'sent' }
  | { kind: 'failed' }
  | { kind: 'skipped' }
  | { kind: 'paused' }

/**
 * One message to one person.
 *
 * The order is the same one the composer's own send path uses, and for the same
 * reasons: refuse everything refusable before anything is written, write the
 * row BEFORE the mail service is called, then settle it either way. The row is
 * what makes a duplicate impossible - a second attempt at the same recipient
 * and step hits a unique index rather than a mail server.
 */
async function sendToRecipient(
  recipient: CampaignRecipient,
  input: { campaign: Campaign; steps: CampaignStep[]; inbox: Awaited<ReturnType<typeof getInbox>>; ctx: RunContext },
): Promise<SendVerdict> {
  const { campaign, steps, inbox, ctx } = input
  if (!inbox) return { kind: 'skipped' }

  const step = steps.find((s) => s.stepIndex === recipient.stepIndex)
  if (!step) {
    // A chase whose step somebody has since deleted. They are finished rather
    // than failed: nothing is wrong, there is simply nothing left to send.
    await setRecipientState(recipient.id, 'done')
    return { kind: 'skipped' }
  }

  // Suppressed since the list was built - unsubscribed from another campaign,
  // or bounced. Checked here rather than only at build time because a fortnight
  // passes between the two.
  if (await isSuppressed(recipient.address)) {
    await setRecipientState(recipient.id, 'unsubscribed', {
      reason: 'They asked not to be emailed again before this reached them.',
    })
    return { kind: 'skipped' }
  }

  // A chase only goes to somebody who has said nothing. Asked at the last
  // possible moment, because a reply that arrived an hour ago still counts.
  if (recipient.stepIndex > 0 && await hasRepliedSince(recipient)) {
    await setRecipientState(recipient.id, 'replied')
    return { kind: 'skipped' }
  }

  const transport = await transportForInbox(inbox)

  let built: Awaited<ReturnType<typeof buildCampaignMessage>>
  let sendId: string | null = null
  try {
    // The Message-ID is settled before anything is written, so that the row and
    // the header that goes out carry the same value: a reply arriving in three
    // weeks quotes it, and it is what makes the copy in the Sent folder
    // recognisable as ours rather than a newly discovered email.
    const messageId = generateMessageId(inbox.address)
    const provisional = await startSend({
      campaignId: campaign.id,
      recipientId: recipient.id,
      stepIndex: step.stepIndex,
      address: recipient.address,
      messageId,
    })
    if (!provisional) {
      // Somebody has already sent this exact step to this exact person. Move
      // them on rather than sending it again - a customer who gets the same
      // mailshot twice unsubscribes, and they are right to.
      await advanceRecipient(recipient.id, {
        sentAt: ctx.now,
        messageId: recipient.lastMessageId ?? messageId,
        subject: recipient.firstSubject ?? '',
        ...nextStepFor(steps, step.stepIndex, ctx.now, campaign, ctx.timezone),
      })
      return { kind: 'skipped' }
    }
    sendId = provisional

    built = await buildCampaignMessage({
      campaign,
      step,
      recipient,
      inbox,
      transport,
      siteName: ctx.siteName,
      postalAddress: ctx.postalAddress,
      sendId,
      messageId,
      trackOpens: ctx.trackOpens,
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    if (sendId) await settleSend(sendId, { ok: false, error: reason })
    await requeueRecipient(recipient.id, null)
    // Whatever this is - no site address, no encryption key - it will be true
    // for the next one too, so the campaign stops rather than failing five
    // thousand times.
    await setCampaignStatus(campaign.id, 'paused', { pauseKind: 'provider', pauseReason: reason })
    return { kind: 'paused' }
  }

  const outcome = await deliver(built.sendable)

  if (!outcome.ok) {
    await settleSend(sendId, { ok: false, error: outcome.error })
    if (isCampaignWideFailure(outcome.error)) {
      // The next one would fail the same way. Put this person back so they go
      // when it is fixed, and stop.
      await requeueRecipient(recipient.id, null)
      await setCampaignStatus(campaign.id, 'paused', {
        pauseKind: 'provider',
        pauseReason: outcome.error,
      })
      return { kind: 'paused' }
    }
    await setRecipientState(recipient.id, 'failed', { reason: outcome.error })
    return { kind: 'failed' }
  }

  const sentAt = new Date()
  await settleSend(sendId, { ok: true, sentAt, providerMessageId: outcome.providerMessageId })
  await advanceRecipient(recipient.id, {
    sentAt,
    messageId: built.messageId,
    subject: built.subject,
    ...nextStepFor(steps, step.stepIndex, sentAt, campaign, ctx.timezone),
  })

  // Filed in the mailbox's own Sent folder, if the campaign asked for it. This
  // one is allowed to fail: the email has gone, and a copy that did not file is
  // a smaller problem than a message reported as unsent.
  if (campaign.copyToSent && inbox.connectionId) {
    try {
      const raw = await buildRawMessage({
        from: built.sendable.from,
        to: built.sendable.to,
        cc: built.sendable.cc,
        replyTo: built.sendable.replyTo,
        subject: built.sendable.subject,
        html: built.sendable.html,
        text: built.sendable.text,
        headers: built.sendable.headers,
        attachments: [],
        sentAt,
      })
      await appendToSent({
        connectionId: inbox.connectionId,
        sentFolder: inbox.sentFolder,
        raw,
        sentAt,
      })
    } catch (err) {
      console.error('[unified-inbox] campaign copy to Sent did not file', err)
    }
  }

  return { kind: 'sent' }
}

/**
 * Which step comes next for somebody who has just been written to, and when.
 *
 * Counted from the moment this message actually left rather than from when it
 * was supposed to: a campaign that ran a day late chases a day late, which is
 * what anybody who set "three days" meant. The window then pushes it to the
 * next moment the campaign may send at all, so a chase falling due on Sunday
 * morning goes out on Monday at nine rather than on Sunday at nine.
 */
function nextStepFor(
  steps: CampaignStep[],
  currentIndex: number,
  sentAt: Date,
  campaign: Campaign,
  timezone: string,
): { nextStepIndex: number | null; nextDueAt: Date | null } {
  const next = steps.find((s) => s.stepIndex > currentIndex)
  if (!next || next.waitDays === null) return { nextStepIndex: null, nextDueAt: null }
  const due = new Date(sentAt.getTime() + next.waitDays * 86_400_000)
  const slot = nextSlot(due, campaign.window, timezone) ?? due
  return { nextStepIndex: next.stepIndex, nextDueAt: slot }
}

/**
 * What a delivery event from the mail service does to a campaign.
 *
 * A hard bounce is the address failing rather than the message failing, so it
 * goes on the suppression list: every campaign, for ever, rather than this one.
 * A soft bounce is a bad afternoon and changes nothing - suppressing on a full
 * mailbox loses a customer permanently over a temporary problem.
 */
export async function suppressForHardBounce(address: string, campaignId: string, detail: string | null): Promise<void> {
  await addSuppression({
    address,
    reason: 'bounced',
    campaignId,
    note: detail ?? 'The mail service said this address does not exist.',
  })
}
