import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getInbox } from './db'
import { ruleProblem, type RuleBody } from './rules'
import { staffUserExists } from './rules-db'

// What every Rules route checks before it does anything. Behind
// `unifiedinbox.manage`, the same as merging by hand: a rule merges, moves and
// hands out conversations with nobody watching, and whoever set the inbox up
// is the one who should be writing them.

type Guarded = { ok: true; userId: string } | { ok: false; response: Response }

export async function requireRulesManager(): Promise<Guarded> {
  const user = await getSessionFromCookie()
  if (!user) return { ok: false, response: errorResponse('Not authenticated', 401) }
  if (!await hasPermission(user, 'unifiedinbox.manage')) return { ok: false, response: errorResponse('Forbidden', 403) }
  return { ok: true, userId: user.id }
}

/**
 * Everything wrong with a rule that needs the database to know: a mailbox or a
 * colleague named in it that is not there. Checked on save so the person
 * writing the rule hears about it, rather than the rule quietly doing nothing
 * for a month.
 */
export async function ruleProblemWithData(rule: RuleBody): Promise<string | null> {
  const plain = ruleProblem(rule)
  if (plain) return plain
  for (const condition of rule.conditions) {
    if (condition.field === 'inbox' && !await getInbox(condition.value)) {
      return 'One of the mailboxes in the conditions is not there any more. Pick another.'
    }
  }
  for (const action of rule.actions) {
    if (action.type === 'move' && !await getInbox(action.inboxId)) {
      return 'The mailbox this rule moves conversations to is not there any more. Pick another.'
    }
    if (action.type === 'assign' && !await staffUserExists(action.userId)) {
      return 'The colleague this rule assigns conversations to no longer has an account. Pick somebody else.'
    }
  }
  return null
}
