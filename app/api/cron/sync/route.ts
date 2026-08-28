import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { syncAllConnections } from '@/modules/unified-inbox/lib/sync'
import { CRON_BUDGET_MS, CRON_PEOPLE_DEADLINE_MS } from '@/modules/unified-inbox/lib/sync-plan'
import { runPeoplePass } from '@/modules/unified-inbox/lib/identity'
import { syncAllProviders, PROVIDER_BUDGET_MS } from '@/modules/unified-inbox/lib/provider-sync'

// The scheduled mail check.
//
// This runs inside the site's single cron dispatcher, which gives any one job
// 25 seconds and then moves on to the next. So the budget below is deliberately
// short of that: the engine finishes the batch it is on, writes its cursors and
// returns, and the next tick carries on from exactly where this one stopped.
// A mailbox with years of history takes many ticks to collect, and that is the
// design rather than a shortcoming.
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
  const outcomes = await syncAllConnections({ budgetMs: CRON_BUDGET_MS })

  // Then the channels another module owns - chat, enquiries, calls, texts.
  // After the mail and inside its own small budget, for the same reason the
  // people pass runs last: their messages are safe where they are and can be
  // copied next tick, while an email nobody fetched may be somewhere else by
  // then.
  const channels = await syncAllProviders({ deadline: Date.now() + PROVIDER_BUDGET_MS })

  // Then, with whatever is left of the slice: work out whose conversations the
  // new ones are, and attach the records they mention. Everything above is
  // already committed, so this stopping early costs a conversation one more
  // tick before it has a name - never a message.
  const people = await runPeoplePass({ deadline: started + CRON_PEOPLE_DEADLINE_MS })

  return NextResponse.json({
    ok: outcomes.every((o) => o.ok) && channels.every((c) => c.ok),
    accounts: outcomes.length,
    collected: outcomes.reduce((total, o) => total + o.stored, 0),
    channels: channels.length,
    channelMessages: channels.reduce((total, c) => total + c.messages, 0),
    people: people.people,
    linked: people.links,
    outcomes,
    channelOutcomes: channels,
  })
}
