import {
  ACTION_LABELS,
  FIELD_LABELS,
  OP_LABELS,
  type RuleAction,
  type RuleActionType,
  type RuleBody,
  type RuleCondition,
} from '@/modules/unified-inbox/lib/rules'

// The Rules tab's vocabulary: what a fresh rule looks like, the templates it
// can start from, and a rule read back as one English sentence. Kept apart
// from the components so the sentence can be tested and the templates read.

export type RuleView = RuleBody & {
  id: string
  position: number
  fireCount: number
  lastFiredAt: string | null
  unreadable: boolean
}

export type Named = { id: string; name: string }

export const CHANNEL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'email', label: 'Email' },
  { value: 'chat', label: 'Live chat' },
  { value: 'form', label: 'Contact form' },
  { value: 'phone', label: 'Phone' },
  { value: 'sms', label: 'Text message' },
  { value: 'whatsapp', label: 'WhatsApp' },
]

export const TEXT_OP_ORDER = ['contains', 'notContains', 'is', 'isNot', 'startsWith', 'endsWith', 'matches', 'notMatches'] as const

let counter = 0
/** A key for a condition row. Only has to be unique within one rule. */
export function newConditionId(): string {
  counter += 1
  return `c${Date.now().toString(36)}${counter.toString(36)}`
}

export function blankCondition(): RuleCondition {
  return { id: newConditionId(), field: 'subject', op: 'contains', value: '' }
}

export function blankAction(type: RuleActionType): RuleAction {
  switch (type) {
    case 'mergeByReference':
      return { type, pattern: '', lookIn: 'subject', sameCompany: true, withinDays: 60 }
    case 'assign': return { type, userId: '' }
    case 'move': return { type, inboxId: '' }
    case 'markDone': return { type }
    case 'markRead': return { type }
    case 'snooze': return { type, days: 3 }
  }
}

export function blankRule(): RuleBody {
  return {
    name: '',
    enabled: true,
    trigger: 'newConversation',
    match: 'all',
    conditions: [blankCondition()],
    actions: [],
    stopProcessing: false,
  }
}

export type RuleTemplate = {
  key: string
  title: string
  blurb: string
  icon: 'merge' | 'person' | 'tick' | 'inbox'
  build: () => RuleBody
}

/** Starting points. Each opens in the editor with the parts only the site can
 *  know left blank for filling in - none of them is saved as it stands. */
export const RULE_TEMPLATES: ReadonlyArray<RuleTemplate> = [
  {
    key: 'merge-reference',
    title: 'Keep replies with what they are about',
    blurb: 'A supplier answers your purchase order with a fresh email that only mentions its number. Put it with the original.',
    icon: 'merge',
    build: () => ({
      ...blankRule(),
      name: 'Replies join the order they mention',
      conditions: [{ id: newConditionId(), field: 'subject', op: 'matches', value: 'PO-#####' }],
      actions: [{ type: 'mergeByReference', pattern: 'PO-#####', lookIn: 'subject', sameCompany: true, withinDays: 60 }],
    }),
  },
  {
    key: 'company-to-person',
    title: 'Hand a company’s mail to one person',
    blurb: 'Everything new from one customer or supplier goes straight to whoever looks after them.',
    icon: 'person',
    build: () => ({
      ...blankRule(),
      name: 'New mail from a company goes to its account manager',
      conditions: [{ id: newConditionId(), field: 'fromDomain', op: 'is', value: '' }],
      actions: [blankAction('assign')],
    }),
  },
  {
    key: 'receipts-done',
    title: 'File receipts away as done',
    blurb: 'Order confirmations and receipts are worth keeping, not worth answering. Mark them read and done.',
    icon: 'tick',
    build: () => ({
      ...blankRule(),
      name: 'Receipts are filed as done',
      match: 'any',
      conditions: [
        { id: newConditionId(), field: 'subject', op: 'contains', value: 'receipt' },
        { id: newConditionId(), field: 'subject', op: 'contains', value: 'order confirmation' },
      ],
      actions: [{ type: 'markRead' }, { type: 'markDone' }],
    }),
  },
  {
    key: 'mailbox-to-team',
    title: 'Move mail to the right mailbox',
    blurb: 'Invoices sent to somebody’s own address belong with accounts. Move them where the team can see them.',
    icon: 'inbox',
    build: () => ({
      ...blankRule(),
      name: 'Invoices go to accounts',
      conditions: [{ id: newConditionId(), field: 'subject', op: 'contains', value: 'invoice' }],
      actions: [blankAction('move')],
    }),
  },
]

function quote(value: string): string {
  return `“${value}”`
}

function conditionWords(condition: RuleCondition, inboxes: Named[]): string {
  const field = FIELD_LABELS[condition.field].toLowerCase()
  switch (condition.field) {
    case 'inbox': {
      const name = inboxes.find((i) => i.id === condition.value)?.name ?? 'a mailbox'
      return condition.op === 'is' ? `it arrived in ${name}` : `it did not arrive in ${name}`
    }
    case 'channel': {
      const label = CHANNEL_OPTIONS.find((c) => c.value === condition.value)?.label ?? condition.value
      return condition.op === 'is' ? `it came by ${label.toLowerCase()}` : `it did not come by ${label.toLowerCase()}`
    }
    case 'attachments':
      return condition.op === 'has' ? 'it has attachments' : 'it has no attachments'
    default: {
      const value = condition.value.trim() || '…'
      return `the ${field} ${OP_LABELS[condition.op]} ${quote(value)}`
    }
  }
}

function actionWords(action: RuleAction, inboxes: Named[], users: Named[]): string {
  switch (action.type) {
    case 'mergeByReference':
      return `merge it with the earlier conversation carrying the same ${action.pattern.trim() ? quote(action.pattern.trim()) : 'reference'}`
    case 'assign':
      return `assign it to ${users.find((u) => u.id === action.userId)?.name ?? '…'}`
    case 'move':
      return `move it to ${inboxes.find((i) => i.id === action.inboxId)?.name ?? '…'}`
    case 'markDone': return 'mark it done'
    case 'markRead': return 'mark it read'
    case 'snooze': return `snooze it for ${action.days === 1 ? 'a day' : `${action.days} days`}`
  }
}

function joinAnd(parts: string[], word: 'and' | 'or' = 'and'): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} ${word} ${parts[parts.length - 1]}`
}

/** The rule as one sentence: "When a new conversation starts and the subject
 *  has a reference like “PO-#####”, merge it with ..." */
export function describeRule(rule: RuleBody, inboxes: Named[], users: Named[]): string {
  const when = rule.trigger === 'newConversation' ? 'When a message starts a new conversation' : 'When any message arrives'
  const conditions = rule.conditions.map((c) => conditionWords(c, inboxes))
  const ifPart = conditions.length === 0
    ? ''
    : ` and ${joinAnd(conditions, rule.match === 'all' ? 'and' : 'or')}`
  const actions = rule.actions.map((a) => actionWords(a, inboxes, users))
  const thenPart = actions.length === 0 ? ', do nothing yet' : `, ${joinAnd(actions)}`
  const stop = rule.stopProcessing ? ', and stop there' : ''
  return `${when}${ifPart}${thenPart}${stop}.`
}

export const ACTION_ORDER: RuleActionType[] = ['mergeByReference', 'assign', 'move', 'markRead', 'markDone', 'snooze']

export { ACTION_LABELS }

/** "3 hours ago", "yesterday", "on the 4th of November". */
export function whenAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  const minutes = Math.round((now - then) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return minutes === 1 ? 'a minute ago' : `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  const d = new Date(iso)
  const day = d.getDate()
  const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th'
  return `on the ${day}${suffix} of ${d.toLocaleString('en-GB', { month: 'long' })}`
}
