import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { sweepAbandonedUploads, sweepRetention, sweepStalledSends } from '@/modules/unified-inbox/lib/retention'
import { sweepAttachmentFiling } from '@/modules/unified-inbox/lib/attachment-backfill'
import { pruneDeliveries } from '@/modules/unified-inbox/lib/webhooks-db'
import { getSettings, wakeDueMentions } from '@/modules/unified-inbox/lib/db'
import { pruneCampaignLogs } from '@/modules/unified-inbox/lib/campaigns/store'
import { reconcileBrevoWebhooks } from '@/modules/unified-inbox/lib/brevo-webhooks'

// The daily tidy: the retention window, and the people it leaves holding
// nothing.
//
// A job of its own rather than another passenger on the mail tick. That tick's
// 25 second slice is already spoken for by collecting the mail, then the other
// channels, then working out whose conversations they are - and none of those
// can wait, whereas removing a year-old conversation eleven hours later than it
// might have been costs precisely nothing.
//
// Everything it does is batched and resumable. A site with ten years of mail
// and a twelve month window catches up over a number of nights rather than
// trying to do it in one, and each night's work is committed before the next
// begins.
//
// The schedule is honoured to the tick rather than to the minute, and on a free
// hosting plan the dispatcher itself only runs once a day - so this is "about
// once a day" rather than "at twenty to four".
export const maxDuration = 60

const BUDGET_MS = 18_000

/** What the attachment filing sweep may have. Smaller than the retention
 *  window's share because each file is a download and an upload rather than a
 *  query, and because it is the one job here that nobody is waiting on. */
const FILING_BUDGET_MS = 12_000

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return errorResponse('CRON_SECRET is not configured', 503)

  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${secret}`) return errorResponse('Unauthorized', 401)

  // Belt and braces: the mail tick does this every hour, and doing it again
  // here costs one update against a partial index holding almost nothing. A
  // site whose mail tick is failing for some other reason still gets its stuck
  // messages marked rather than being left staring at "sending" for a week.
  const stalledSends = await sweepStalledSends()

  // Asks a colleague put off until later. The hub wakes these itself every time
  // somebody opens it, which covers the case that matters; this is for the
  // conversation nobody has looked at, so the number beside "Asked me" is right
  // when they do.
  const wokenMentions = await wakeDueMentions()
  const retention = await sweepRetention({ deadline: Date.now() + BUDGET_MS })

  // What was sent, or given up on, a month ago is a log rather than a queue,
  // and a log nobody prunes is a table nobody meant to create.
  const webhookAttempts = await pruneDeliveries(30)

  // Files dragged onto a message that was then never sent and never saved. Only
  // the ones nothing at all points at, and only once they are a week old - a
  // draft holding one keeps it for as long as the draft lives.
  const uploads = await sweepAbandonedUploads()

  // Attachments collected before this module filed them into the media library,
  // moved into it a few at a time. Nothing moves them otherwise: a file is only
  // ever filed at the moment its bytes are written, and bytes fetched last
  // March are never written again. Last of the sweeps and on whatever time is
  // left, because it is the only one here that is catching up on history rather
  // than keeping up with the present - every other night's work still gets done
  // on a morning when this one gets none.
  const filing = await sweepAttachmentFiling({ deadline: Date.now() + FILING_BUDGET_MS })

  // The send-by-send ledger of campaigns that finished long ago. The recipient
  // rows are what hold a name, an address and a company, so those are what go;
  // the campaign itself stays, because "we sent that in March" is a fact about
  // the business rather than about a person. Batched like everything else here,
  // so four years of it catches up over a few nights.
  const settings = await getSettings()
  const campaignCutoff = new Date()
  campaignCutoff.setMonth(campaignCutoff.getMonth() - settings.campaignLogMonths)
  const campaignRows = await pruneCampaignLogs(campaignCutoff, 500)

  // Telling the mail service what to send us, again.
  //
  // Which list of events we want is decided in this module's own code, so an
  // update can change it - clicks were added to it long after the webhook on
  // every existing site was registered. Registering happens when somebody saves
  // the settings and nowhere else, which meant an update that asked for a new
  // event quietly never received one until the owner happened to press Save on
  // a screen they had no reason to open.
  //
  // So once a night, if the site is watching at all. It is a reconcile rather
  // than a registration - it reads what the account already has and puts it
  // right - and it is written not to throw, because a key that expired in
  // March must not be what stops the retention sweep running in April. It also
  // quietly repairs the older case this file was not written for: a site
  // restored from a backup, whose webhook points at whatever the old site's
  // address was.
  const brevoAccounts = settings.trackOpens
    ? (await reconcileBrevoWebhooks(true).catch(() => [])).filter((one) => !one.ok).length
    : 0

  return NextResponse.json({
    ok: true,
    stalledSends,
    wokenMentions,
    webhookAttempts,
    abandonedUploads: uploads.removed,
    abandonedUploadFailures: uploads.failures,
    campaignRows,
    brevoAccountsUnreachable: brevoAccounts,
    attachmentsFiled: filing.filed,
    attachmentsToFile: filing.remaining,
    attachmentFilingFailures: filing.failures,
    ...retention,
  })
}
