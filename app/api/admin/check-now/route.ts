import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getConnection, listConnections } from '@/modules/unified-inbox/lib/db'
import { syncConnection } from '@/modules/unified-inbox/lib/sync'
import {
  MANUAL_BUDGET_MS,
  MANUAL_PEOPLE_DEADLINE_MS,
  MANUAL_TICK_DEADLINE_MS,
  makeDeadline,
  outOfTime,
} from '@/modules/unified-inbox/lib/sync-plan'
import { runPeoplePass } from '@/modules/unified-inbox/lib/identity'
import { syncAllProviders, PROVIDER_BUDGET_MS } from '@/modules/unified-inbox/lib/provider-sync'
import { deliverPending, WEBHOOK_BUDGET_MS } from '@/modules/unified-inbox/lib/webhooks'
import { cooldownFor, dueForCheck } from '@/modules/unified-inbox/lib/check-cooldown'
import { runDueScheduledSends } from '@/modules/unified-inbox/lib/scheduled-send'

// Check now. Same engine as the hourly job, a bigger slice of clock (E9): this
// runs in a module route with a 60 second ceiling of its own rather than inside
// the dispatcher's 25 second slot, so a first collection visibly moves along
// while somebody is watching it happen.
//
// The cooldown is a minute, and it is a minute PER ACCOUNT: iCloud caps
// concurrent connections per account and the per-account lock would turn a
// second visit away anyway, so an account checked seconds ago is stepped over
// and the rest are collected as normal.
//
// An account resting is NOT an error, and used to be answered with a 429 that
// the screen showed as "a check has just run - give it 49 seconds". Somebody
// pressing refresh a moment after the page checked on its own is asking to see
// what is there, not asking for a lecture about how recently they asked. So
// every one of these answers is ok, `checked` says whether anything was
// actually collected, and the screen refreshes either way - which is the whole
// of what the button was for. Nothing is hidden: the message still says the
// mail was checked a moment ago rather than pretending a check just ran.
export const maxDuration = 60

export async function POST(request: Request) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const body = await request.json().catch(() => ({}))
  const connectionId = typeof body?.connectionId === 'string' ? body.connectionId : null
  // A round the page ran on its own, rather than one somebody pressed for.
  const automatic = body?.auto === true

  const connections = connectionId
    ? [await getConnection(connectionId)].filter((c): c is NonNullable<typeof c> => !!c)
    : await listConnections()

  if (connections.length === 0) {
    return errorResponse('There is no mail account set up yet.', 400)
  }

  const { due, restedSeconds } = dueForCheck(connections, cooldownFor(automatic))

  const started = Date.now()

  // Anything written earlier and due to go out by now, before a single mailbox
  // is opened. The scheduled tick is hourly at best on Vercel and daily on the
  // free plan, and somebody sitting in front of the inbox is a better clock
  // than either - a message set for half past nine leaves at half past nine
  // rather than at ten. Its own claim is what stops it also going out on the
  // tick, so the two runs cannot post the same message twice.
  //
  // Small slice, and deliberately not allowed to sink the check: whatever it
  // does not get through is still due, and the tick will have it.
  const posted = await runDueScheduledSends({ deadline: started + 8_000 }).catch(() => null)
  // Every account was opened moments ago, so there is nothing worth opening
  // again. The answer is still a good one - the screen reloads on the back of
  // it and shows whatever that check brought in.
  if (due.length === 0) {
    const ago = restedSeconds ?? 0
    return NextResponse.json({
      ok: true,
      checked: false,
      collected: 0,
      sentOnSchedule: posted?.sent ?? 0,
      stillWorking: false,
      error: null,
      message: `Your mail was checked ${ago} second${ago === 1 ? '' : 's'} ago, so this is up to date.`,
    })
  }

  // One at a time and against one shared deadline, exactly as the hourly job
  // walks them: several mailboxes opened at once on one serverless function is
  // a way to reach the ceiling with every one of them half done.
  const deadline = makeDeadline(MANUAL_BUDGET_MS, started)
  const outcomes = []
  for (const connection of due) {
    if (outOfTime(deadline)) break
    outcomes.push(await syncConnection(connection.id, { deadline }))
  }

  // The other channels are collected when somebody asks for everything. Asking
  // about one mail account means one mail account.
  const channels = connectionId
    ? []
    : await syncAllProviders({
        deadline: Math.min(Date.now() + PROVIDER_BUDGET_MS, started + MANUAL_TICK_DEADLINE_MS),
      })

  // Same people pass the hourly job runs, with the bigger slice this route has.
  await runPeoplePass({ deadline: started + MANUAL_PEOPLE_DEADLINE_MS })

  // Somebody pressed the button and is watching the screen, so anything this
  // check queued goes out now rather than waiting for the next scheduled tick.
  await deliverPending({ deadline: Date.now() + WEBHOOK_BUDGET_MS })

  const failed = outcomes.find((o) => !o.ok)
  const collected =
    outcomes.reduce((total, o) => total + o.stored, 0) +
    channels.reduce((total, c) => total + c.messages, 0)
  const stillWorking = outcomes.some((o) => o.folders.some((f) => !f.backfillComplete))

  return NextResponse.json({
    ok: !failed,
    checked: true,
    collected,
    sentOnSchedule: posted?.sent ?? 0,
    stillWorking,
    error: failed?.error ?? null,
    message: failed
      ? failed.error
      : collected === 0
        ? 'Nothing new to collect.'
        : `Collected ${collected} message${collected === 1 ? '' : 's'}.${stillWorking ? ' Still working through your older mail in the background.' : ''}`,
  })
}
