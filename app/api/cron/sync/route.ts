import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { syncAllConnections } from '@/modules/unified-inbox/lib/sync'
import {
  CRON_BUDGET_MS,
  CRON_PEOPLE_DEADLINE_MS,
  CRON_TICK_DEADLINE_MS,
  catchUpDeadline,
} from '@/modules/unified-inbox/lib/sync-plan'
import { runPeoplePass } from '@/modules/unified-inbox/lib/identity'
import { syncAllProviders, PROVIDER_BUDGET_MS } from '@/modules/unified-inbox/lib/provider-sync'
import { sweepStalledSends } from '@/modules/unified-inbox/lib/retention'
import { deliverPending, WEBHOOK_BUDGET_MS } from '@/modules/unified-inbox/lib/webhooks'
import { NUDGE_BUDGET_MS, sendPushNudges } from '@/modules/unified-inbox/lib/push-nudges'
import { CATCH_UP_BUDGET_MS, catchUpMessageHandlers } from '@/modules/unified-inbox/lib/message-handlers'

// The scheduled mail check.
//
// This runs inside the site's single cron dispatcher, which calls each due job
// in turn with whatever is left of its own run: at most 54 seconds (its 60
// less a 6 second reserve), and less when other jobs due the same minute went
// first. The passes below each hold a budget of their own and are capped
// against the start of this run - collection and the channels by 24 seconds,
// the catch-up for the modules listening for post by 48 (see
// CRON_CATCH_UP_CEILING_MS in lib/sync-plan.ts for the arithmetic). The engine
// finishes the batch it is on, writes its cursors and returns, and the next
// tick carries on from exactly where this one stopped. A mailbox with years of
// history takes many ticks to collect, and that is the design rather than a
// shortcoming.
//
// When the dispatcher's allowance is shorter than that - sync was not the
// first job due - it may abort this run part-way. That loses nothing: every
// pass commits as it goes, an offer to a listening module interrupted
// mid-flight leaves a claim that expires after two minutes, and the message
// is offered again by the next hour's catch-up.
//
// The tick itself is hourly on a paid Vercel plan and once a DAY on Hobby -
// the dispatcher honours a schedule to the tick, not to the minute. A site that
// wants its mail sooner presses Check now, which gets a bigger slice because
// somebody is sitting there watching it.
//
// Vercel appends `Authorization: Bearer $CRON_SECRET` to its own cron requests
// automatically when CRON_SECRET is set - no separate secret scheme needed.
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return errorResponse('CRON_SECRET is not configured', 503)

  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${secret}`) return errorResponse('Unauthorized', 401)

  const started = Date.now()

  // First, and cheaply: anything left saying "sending" from a run that crashed
  // between writing the row and the send answering. One update against a
  // partial index that on any ordinary site holds no rows at all, and it means
  // nobody stares at a message stuck mid-flight for longer than an hour. The
  // rest of the tidying is a daily job of its own - see cron/housekeeping.
  const stalledSends = await sweepStalledSends()

  const outcomes = await syncAllConnections({ budgetMs: CRON_BUDGET_MS })

  // Then the channels another module owns - chat, enquiries, calls, texts.
  // After the mail and inside its own small budget, for the same reason the
  // people pass runs last: their messages are safe where they are and can be
  // copied next tick, while an email nobody fetched may be somewhere else by
  // then.
  const channels = await syncAllProviders({
    deadline: Math.min(Date.now() + PROVIDER_BUDGET_MS, started + CRON_TICK_DEADLINE_MS),
  })

  // Then tell the people it is for, while it is still news: a browser that
  // said yes to nudges hears about what was just filed now, rather than after
  // the slower passes below. Cheap when nothing arrived - one indexed insert.
  const nudges = await sendPushNudges({ deadline: Date.now() + NUDGE_BUDGET_MS })

  // Then, with whatever is left of the slice: work out whose conversations the
  // new ones are, and attach the records they mention. Everything above is
  // already committed, so this stopping early costs a conversation one more
  // tick before it has a name - never a message.
  const people = await runPeoplePass({ deadline: started + CRON_PEOPLE_DEADLINE_MS })

  // Last of all: tell whatever asked to be told. Nothing above depends on it,
  // an endpoint that hangs costs only the small slice below, and a delivery
  // that does not get away this tick is picked up by the next one.
  const webhooks = await deliverPending({ deadline: Date.now() + WEBHOOK_BUDGET_MS })

  // And the safety net for the modules listening for post: anything from the
  // last three days that was never offered to them - a pass that ran out of
  // time, a deploy mid-flight, a listener installed after the post came. On a
  // site where nothing listens this returns before it reads a single row.
  // Capped against the start of the run, not only against now: see
  // CRON_CATCH_UP_CEILING_MS for the arithmetic. Too little left and it does
  // nothing at all this tick.
  const handlers = await catchUpMessageHandlers({ deadline: catchUpDeadline(started, CATCH_UP_BUDGET_MS) })

  return NextResponse.json({
    ok: outcomes.every((o) => o.ok) && channels.every((c) => c.ok),
    accounts: outcomes.length,
    collected: outcomes.reduce((total, o) => total + o.stored, 0),
    channels: channels.length,
    channelMessages: channels.reduce((total, c) => total + c.messages, 0),
    stalledSends,
    nudges,
    people: people.people,
    linked: people.links,
    offeredToModules: handlers.offered,
    outcomes,
    channelOutcomes: channels,
  })
}
