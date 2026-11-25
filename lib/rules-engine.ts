import {
  assignThread,
  getInbox,
  getSettings,
  mergeThreads,
  moveThreadToInbox,
  recordEvent,
  setThreadRead,
  setThreadStatus,
} from './db'
import { isPersonalDomain } from './people'
import {
  bareAddress,
  domainOfAddress,
  mergeReferences,
  ruleMatches,
  type RuleAction,
  type RuleBody,
  type RuleMessage,
} from './rules'
import {
  claimRuleRun,
  enabledRules,
  finishRuleRun,
  findMergeTarget,
  getRule,
  loadRuleMessage,
  loadRuleMessages,
  newestInboundMessageIds,
  recentInboundMessageIds,
  releaseRuleRun,
  staffUserExists,
  threadBasics,
  type MergeTarget,
  type RuleRow,
} from './rules-db'

// ---------------------------------------------------------------------------
// Running rules.
//
// Called by the collecting pass for every inbound message it files (email and
// every other channel alike), after the message is safely stored and BEFORE
// the webhooks are queued and the listening modules are offered it - so a
// merge has already put the message where it belongs by the time anybody else
// looks at which conversation it is on.
//
// Four things hold everywhere:
//
//   - A rule runs on a message once (claimRuleRun). Re-collecting the same
//     email, or "run on recent mail" reaching it afterwards, does nothing.
//   - Nothing here ever throws into the collecting pass. A rule having a bad
//     day costs that rule that message, and the post is still collected.
//   - Every change a rule makes is written in the conversation's own timeline
//     under the rule's name, so "why is this here?" has an answer.
//   - On a site with no rules, each message costs one cached read and nothing
//     else.
// ---------------------------------------------------------------------------

type MergeAction = Extract<RuleAction, { type: 'mergeByReference' }>

/** What one action came to: words for the log, or null when it had nothing to
 *  do (no earlier conversation to merge with, already assigned to that
 *  person...). */
type ActionOutcome = { summary: string; threadId?: string; mergeIds?: string[] } | null

/** Who "the same company" is, for a merge: the sender's domain, or the
 *  sender's own address where the domain is one everybody shares. */
async function companyOf(message: RuleMessage): Promise<{ domain: string } | { address: string } | null> {
  const address = bareAddress(message.fromAddress)
  const domain = domainOfAddress(message.fromAddress)
  if (!address || !domain) return null
  const settings = await getSettings()
  return isPersonalDomain(domain, settings.personalDomains) ? { address } : { domain }
}

/** The conversation a merge action would fold this message's conversation
 *  into, or null - shared by the real run and the preview, so the preview
 *  cannot promise a merge the run would not make. */
async function mergeTargetFor(action: MergeAction, message: RuleMessage): Promise<MergeTarget | null> {
  if (!message.startsConversation) return null
  // Email only. A chat or a text is filed by the channel that owns it, which
  // keeps putting its next message on the conversation it knows - merging one
  // away would leave the channel writing onto a conversation no list shows.
  if (message.channel !== 'email') return null
  const references = mergeReferences(action, message)
  if (references.length === 0) return null
  const thread = await threadBasics(message.threadId)
  if (!thread) return null
  const company = action.sameCompany ? await companyOf(message) : null
  // Asked for the same company and there is no sender to go on (a text from a
  // withheld number): no merge, rather than a merge with anybody.
  if (action.sameCompany && !company) return null
  return findMergeTarget({
    threadId: message.threadId,
    threadCreatedAt: thread.createdAt,
    references,
    withinDays: action.withinDays,
    company,
  })
}

function quoted(subject: string | null | undefined): string {
  const s = (subject ?? '').trim()
  return s ? `“${s.length > 90 ? `${s.slice(0, 87)}…` : s}”` : 'a conversation with no subject'
}

async function runAction(
  action: RuleAction,
  rule: RuleRow,
  message: RuleMessage,
  threadId: string,
): Promise<ActionOutcome> {
  const tag = { ruleId: rule.id, ruleName: rule.name }
  switch (action.type) {
    case 'mergeByReference': {
      // Only ever the conversation this message started. A merge always folds
      // the newer conversation into the older one, never the other way round.
      if (threadId !== message.threadId) return null
      const target = await mergeTargetFor(action, message)
      if (!target) return null
      const result = await mergeThreads(target.id, [threadId], null, undefined, undefined, tag)
      if ('error' in result) {
        console.warn(`[unified-inbox] rule "${rule.name}" could not merge ${threadId} into ${target.id}: ${result.error}`)
        return null
      }
      return {
        summary: `merged ${quoted(message.subject)} into ${quoted(target.subject)}`,
        threadId: result.winnerId,
        mergeIds: result.mergeIds,
      }
    }
    case 'assign': {
      const thread = await threadBasics(threadId)
      if (!thread || thread.assigneeUserId === action.userId) return null
      if (!await staffUserExists(action.userId)) return null
      await assignThread(threadId, action.userId)
      await recordEvent(threadId, null, 'assigned', { to: action.userId, automatic: true, ...tag })
      return { summary: 'assigned it' }
    }
    case 'move': {
      const thread = await threadBasics(threadId)
      if (!thread || thread.inboxId === action.inboxId) return null
      const target = await getInbox(action.inboxId)
      if (!target) return null
      const from = thread.inboxId ? await getInbox(thread.inboxId) : null
      const moved = await moveThreadToInbox(threadId, action.inboxId)
      if (!moved) return null
      await recordEvent(threadId, null, 'moved', {
        fromInboxId: moved.fromInboxId,
        fromName: from?.name ?? null,
        toInboxId: action.inboxId,
        toName: target.name,
        ...tag,
      })
      return { summary: `moved it to ${target.name}` }
    }
    case 'markDone': {
      const thread = await threadBasics(threadId)
      if (!thread || thread.status === 'done') return null
      await setThreadStatus(threadId, 'done', null)
      await recordEvent(threadId, null, 'status', { status: 'done', was: thread.status, ...tag })
      return { summary: 'marked it done' }
    }
    case 'markRead': {
      const thread = await threadBasics(threadId)
      if (!thread || !thread.unread) return null
      await setThreadRead(threadId, false)
      return { summary: 'marked it read' }
    }
    case 'snooze': {
      const thread = await threadBasics(threadId)
      if (!thread) return null
      const until = new Date(Date.now() + action.days * 86_400_000)
      await setThreadStatus(threadId, 'snoozed', until)
      await recordEvent(threadId, null, 'snoozed', { until: until.toISOString(), was: thread.status, ...tag })
      return { summary: `snoozed it for ${action.days === 1 ? 'a day' : `${action.days} days`}` }
    }
  }
}

/** "merged X into Y, assigned it and marked it done" - the log's one line. */
function joinSummaries(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/**
 * One rule, one message: claim it, do what it says, write it down. Returns
 * whether the rule did anything.
 *
 * Merge goes first whatever order the actions were written in, because the
 * others should land on the conversation the message ends up on, not the one
 * it is about to leave.
 */
async function applyRule(rule: RuleRow, message: RuleMessage): Promise<boolean> {
  const runId = await claimRuleRun(rule.id, message.messageId, message.threadId)
  if (!runId) return false

  const ordered = [
    ...rule.actions.filter((a) => a.type === 'mergeByReference'),
    ...rule.actions.filter((a) => a.type !== 'mergeByReference'),
  ]
  let threadId = message.threadId
  const said: string[] = []
  const mergeIds: string[] = []
  for (const action of ordered) {
    try {
      const outcome = await runAction(action, rule, message, threadId)
      if (!outcome) continue
      said.push(outcome.summary)
      if (outcome.threadId) threadId = outcome.threadId
      if (outcome.mergeIds) mergeIds.push(...outcome.mergeIds)
    } catch (err) {
      console.error(`[unified-inbox] rule "${rule.name}" failed on message ${message.messageId}`, err)
    }
  }

  if (said.length === 0) {
    // Matched, but nothing to do yet. Given back, so a later run - the
    // partner conversation having arrived since - can still have its go.
    await releaseRuleRun(runId)
    return false
  }
  const summary = joinSummaries(said)
  await finishRuleRun({
    runId,
    ruleId: rule.id,
    threadId,
    summary: summary.charAt(0).toUpperCase() + summary.slice(1),
    detail: { mergeIds, fromThreadId: message.threadId },
  })
  return true
}

/**
 * Every switched-on rule, in order, against one newly collected message.
 * Never throws.
 */
export async function applyRulesToMessage(messageId: string): Promise<void> {
  try {
    const rules = await enabledRules()
    if (rules.length === 0) return
    let message = await loadRuleMessage(messageId)
    if (!message) return
    for (const rule of rules) {
      if (!ruleMatches(rule, message)) continue
      const acted = await applyRule(rule, message)
      if (acted && rule.stopProcessing) break
      // A merge moved the message: what the next rule reads (which
      // conversation, which mailbox) should be where it is now.
      if (acted) {
        const reread = await loadRuleMessage(messageId)
        if (!reread) break
        message = reread
      }
    }
  } catch (err) {
    console.error(`[unified-inbox] rules could not run on message ${messageId}`, err)
  }
}

// ---------------------------------------------------------------------------
// The Rules tab: trying a rule out, and running one over mail already here.
// ---------------------------------------------------------------------------

/** How many recent messages the preview reads before it stops looking. */
const PREVIEW_SCAN = 400
/** How many matches it shows. */
const PREVIEW_SHOW = 25

export type RulePreviewMatch = {
  messageId: string
  threadId: string
  subject: string | null
  from: string | null
  /** What the rule would do, in words. */
  outcome: string
  /** Whether the rule would actually change anything. */
  wouldAct: boolean
}

/**
 * What a rule - saved or not - would have done to the last few weeks of post.
 * Reads only. The merge half asks exactly the question the real run asks, so
 * "would merge into X" here means the real thing would.
 */
export async function previewRule(rule: RuleBody, days: number): Promise<{
  scanned: number
  matched: number
  matches: RulePreviewMatch[]
}> {
  const ids = await newestInboundMessageIds(days, PREVIEW_SCAN)
  const matches: RulePreviewMatch[] = []
  let matched = 0
  for (const message of await loadRuleMessages(ids)) {
    if (!ruleMatches(rule, message)) continue
    matched++
    if (matches.length >= PREVIEW_SHOW) continue
    const parts: string[] = []
    let wouldAct = false
    for (const action of rule.actions) {
      if (action.type === 'mergeByReference') {
        const target = await mergeTargetFor(action, message)
        if (target) {
          parts.push(`merge into ${quoted(target.subject)}`)
          wouldAct = true
        } else {
          parts.push('nothing earlier to merge with')
        }
      } else {
        wouldAct = true
      }
    }
    const others = rule.actions.filter((a) => a.type !== 'mergeByReference').length
    if (others > 0) parts.push(others === 1 ? 'one more step' : `${others} more steps`)
    matches.push({
      messageId: message.messageId,
      threadId: message.threadId,
      subject: message.subject,
      from: message.fromName || message.fromAddress,
      outcome: parts.join(', then '),
      wouldAct,
    })
  }
  return { scanned: ids.length, matched, matches }
}

/** Messages per request when running a rule over recent mail. */
const BACKFILL_PAGE = 25

/**
 * One saved rule over a slice of recent post, oldest first. The screen calls
 * it again with `next` until `done`. Messages the rule has already run on are
 * stepped over by the claim, so pressing it twice is pressing it once.
 */
export async function backfillRule(ruleId: string, days: number, after: string | null): Promise<
  { error: string } | { applied: number; looked: number; next: string | null; done: boolean }
> {
  const rule = await getRule(ruleId)
  if (!rule) return { error: 'That rule is not there any more.' }
  if (rule.unreadable) return { error: 'This rule was written by a different version of the inbox and cannot be run. Open it and save it again.' }
  const ids = await recentInboundMessageIds(days, after, BACKFILL_PAGE)
  let applied = 0
  for (const id of ids) {
    try {
      // One at a time rather than loaded up front: an earlier merge in this
      // slice can change which conversation a later message starts.
      const message = await loadRuleMessage(id)
      if (!message || !ruleMatches(rule, message)) continue
      if (await applyRule(rule, message)) applied++
    } catch (err) {
      console.error(`[unified-inbox] rule "${rule.name}" failed on message ${id} while catching up`, err)
    }
  }
  const last = ids[ids.length - 1] ?? null
  return { applied, looked: ids.length, next: last, done: ids.length < BACKFILL_PAGE }
}
