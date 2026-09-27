import { pushRingState } from './db'
import { runPeoplePass } from './identity'
import { PUSH_WAIT_POLL_MS, ringAnswered } from './push-checks'
import { syncConnection } from './sync'
import { makeDeadline, outOfTime } from './sync-plan'
import { deliverPending, WEBHOOK_BUDGET_MS } from './webhooks'

// What a ring does once the provider has been thanked. See lib/push-checks.ts.

export type PushCollectOutcome = {
  /** Mail filed by the check this ring ran. Zero when another check covered it. */
  stored: number
  /** Whether a check has now read every folder since the ring. */
  answered: boolean
  error?: string
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function collectOnPush(
  connectionId: string,
  rang: Date,
  opts: { budgetMs: number },
): Promise<PushCollectOutcome> {
  const started = Date.now()
  const deadline = makeDeadline(opts.budgetMs, started)
  // Collection gets the slice bar the last fourteen seconds: six for the people
  // pass, then eight for the colleague webhooks - which are what tell an agent
  // watching this address that something has arrived.
  const collectBy = deadline - 14_000
  const result: PushCollectOutcome = { stored: 0, answered: false }

  while (!outOfTime(collectBy)) {
    // Another check - a ring just before this one, a Check now, the hourly
    // job's safety net - may already have read every folder since this ring.
    if (ringAnswered(rang, (await pushRingState(connectionId)).answeredAt)) {
      result.answered = true
      break
    }
    const outcome = await syncConnection(connectionId, { deadline: collectBy })
    if (outcome.skipped === 'locked') {
      // Somebody is reading the account now. They note the newest ring as
      // they go and go back round for one that arrives mid-read, so this one
      // waits for them to say so rather than opening a second connection.
      await pause(PUSH_WAIT_POLL_MS)
      continue
    }
    result.stored = outcome.stored
    result.answered = outcome.ok && ringAnswered(rang, (await pushRingState(connectionId)).answeredAt)
    if (!outcome.ok) result.error = outcome.error
    break
  }

  // Same passes the hourly job and Check now run after the mail, so whoever
  // is told about new post hears about it now rather than on the hour.
  if (result.stored > 0) {
    await runPeoplePass({ deadline: deadline - WEBHOOK_BUDGET_MS })
  }
  await deliverPending({ deadline: Math.min(Date.now() + WEBHOOK_BUDGET_MS, deadline) })

  if (!result.answered) {
    console.warn('[unified-inbox] a new-mail ring was not covered before its time ran out', {
      connectionId,
      error: result.error ?? null,
    })
  }
  return result
}
