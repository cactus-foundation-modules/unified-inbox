import { z } from 'zod'

// ---------------------------------------------------------------------------
// Inbox rules: "when mail like this arrives, do that to it".
//
// The case that started it is worth keeping in mind, because it is the shape
// of most of them. A purchase order goes out from purchasing@ to a supplier.
// The supplier's system answers it with a brand-new email to somebody's own
// address - no reply headers, a subject of its own ("Sales Order 0000980102 -
// PO-00091") - so the inbox, quite reasonably, starts a second conversation.
// The one thing the two have in common is the reference in the subject. A rule
// says "a new email whose subject carries a reference like PO-##### belongs
// with the earlier conversation carrying the same one", and from then on it
// does.
//
// What a site does with that is the site's business, so none of it is built
// in: a rule is data, written on the Rules tab by whoever runs the inbox, and
// the inbox only knows how to read one. Nothing here names a supplier, a
// reference format or an address.
//
// This file is the half with no database in it - the shapes, the validation,
// the pattern language and the matching - so all of it can be argued with in a
// test. lib/rules-db.ts stores rules; lib/rules-engine.ts runs them.
// ---------------------------------------------------------------------------

/** Rules per site. Not a technical limit: past this somebody is using rules
 *  to do a job a mail filter on the server would do better. */
export const MAX_RULES = 100
export const MAX_CONDITIONS = 12
export const MAX_ACTIONS = 8
/** How far back a merge looks for the conversation it belongs with. */
export const MAX_MERGE_DAYS = 365
/** How far back "run on recent mail" and the preview will go. */
export const MAX_BACKFILL_DAYS = 90

// ---------------------------------------------------------------------------
// The vocabulary.
// ---------------------------------------------------------------------------

export const TEXT_FIELDS = ['from', 'fromDomain', 'fromName', 'recipients', 'subject', 'body'] as const
export type TextField = (typeof TEXT_FIELDS)[number]

export const TEXT_OPS = ['contains', 'notContains', 'is', 'isNot', 'startsWith', 'endsWith', 'matches', 'notMatches'] as const
export type TextOp = (typeof TEXT_OPS)[number]

const TextCondition = z.object({
  id: z.string().min(1).max(40),
  field: z.enum(TEXT_FIELDS),
  op: z.enum(TEXT_OPS),
  value: z.string().trim().min(1).max(500),
})

const InboxCondition = z.object({
  id: z.string().min(1).max(40),
  field: z.literal('inbox'),
  op: z.enum(['is', 'isNot']),
  value: z.string().min(1).max(200),
})

const ChannelCondition = z.object({
  id: z.string().min(1).max(40),
  field: z.literal('channel'),
  op: z.enum(['is', 'isNot']),
  value: z.string().min(1).max(60),
})

const AttachmentCondition = z.object({
  id: z.string().min(1).max(40),
  field: z.literal('attachments'),
  op: z.enum(['has', 'hasNone']),
  value: z.string().max(0).optional().default(''),
})

export const RuleCondition = z.discriminatedUnion('field', [
  // A discriminated union wants one literal per member, so the text fields are
  // spelled out rather than sharing TextCondition's enum.
  TextCondition.extend({ field: z.literal('from') }),
  TextCondition.extend({ field: z.literal('fromDomain') }),
  TextCondition.extend({ field: z.literal('fromName') }),
  TextCondition.extend({ field: z.literal('recipients') }),
  TextCondition.extend({ field: z.literal('subject') }),
  TextCondition.extend({ field: z.literal('body') }),
  InboxCondition,
  ChannelCondition,
  AttachmentCondition,
])
export type RuleCondition = z.infer<typeof RuleCondition>

export const RuleAction = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('mergeByReference'),
    /** The reference, in the pattern language below: `PO-#####`. */
    pattern: z.string().trim().min(2).max(80),
    /** Where on the arriving message the reference is looked for. */
    lookIn: z.enum(['subject', 'subjectOrBody']),
    /** Only merge with a conversation the same company is on - the sender's
     *  domain, or for a personal address (gmail and friends) the address
     *  itself. On by default, and the screen says why. */
    sameCompany: z.boolean(),
    withinDays: z.number().int().min(1).max(MAX_MERGE_DAYS),
  }),
  z.object({ type: z.literal('assign'), userId: z.string().min(1).max(200) }),
  z.object({ type: z.literal('move'), inboxId: z.string().min(1).max(200) }),
  z.object({ type: z.literal('markDone') }),
  z.object({ type: z.literal('markRead') }),
  z.object({ type: z.literal('snooze'), days: z.number().int().min(1).max(90) }),
])
export type RuleAction = z.infer<typeof RuleAction>
export type RuleActionType = RuleAction['type']

export const RULE_TRIGGERS = ['newConversation', 'everyMessage'] as const
export type RuleTrigger = (typeof RULE_TRIGGERS)[number]

export const RuleBody = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean(),
  trigger: z.enum(RULE_TRIGGERS),
  match: z.enum(['all', 'any']),
  conditions: z.array(RuleCondition).max(MAX_CONDITIONS),
  actions: z.array(RuleAction).min(1).max(MAX_ACTIONS),
  stopProcessing: z.boolean(),
  /** Run every step on mail the site sends as well, not only the merge. Off
   *  unless asked for - see actionsForMessage. Defaulted so a screen from
   *  before the option existed still saves. */
  includeSent: z.boolean().default(false),
})
export type RuleBody = z.infer<typeof RuleBody>

export const RulePatchBody = z.object({
  enabled: z.boolean().optional(),
})

export const RuleOrderBody = z.object({
  ids: z.array(z.string().min(1).max(200)).min(1).max(MAX_RULES),
})

export const RuleBackfillBody = z.object({
  days: z.number().int().min(1).max(MAX_BACKFILL_DAYS),
  /** The message the previous slice stopped after, or null to start. */
  after: z.string().max(200).nullable().optional(),
})

export const RulePreviewBody = z.object({
  rule: RuleBody,
  days: z.number().int().min(1).max(MAX_BACKFILL_DAYS),
})

export type StoredRule = RuleBody & {
  id: string
  position: number
  fireCount: number
  lastFiredAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Everything the rest of a rule says, checked beyond its shape. Zod has said
 * the pieces are the right types; this says they make sense together, in the
 * words the person writing the rule would use.
 */
export function ruleProblem(rule: RuleBody): string | null {
  const types = rule.actions.map((a) => a.type)
  for (const type of new Set(types)) {
    if (types.filter((t) => t === type).length > 1) {
      return `“${ACTION_LABELS[type]}” is in this rule twice. Once is plenty.`
    }
  }
  if (types.includes('markDone') && types.includes('snooze')) {
    return 'A rule can mark a conversation done or snooze it, but not both.'
  }
  const merge = rule.actions.find((a) => a.type === 'mergeByReference')
  if (merge) {
    if (rule.trigger !== 'newConversation') {
      return 'Merging only makes sense for mail that starts a new conversation. Change “When” to “a message starts a new conversation”.'
    }
    const problem = patternProblem(merge.pattern)
    if (problem) return problem
  }
  for (const condition of rule.conditions) {
    if ((condition.op === 'matches' || condition.op === 'notMatches')) {
      const problem = patternProblem(condition.value)
      if (problem) return problem
    }
  }
  return null
}

export const ACTION_LABELS: Record<RuleActionType, string> = {
  mergeByReference: 'Merge with the earlier conversation',
  assign: 'Assign to',
  move: 'Move to mailbox',
  markDone: 'Mark as done',
  markRead: 'Mark as read',
  snooze: 'Snooze',
}

// ---------------------------------------------------------------------------
// The pattern language.
//
// Not a regular expression, on purpose. The person writing a rule runs a
// business; `PO-#####` is something they can read and write, and
// `(?<![A-Za-z0-9])PO-\d{5}(?![A-Za-z0-9])` is not. It is also not something a
// stray bracket can turn into a query that never finishes.
//
//   #   one digit                  PO-#####   matches PO-00091
//   @   one letter                 @@-####    matches AB-1234
//   *   a run of letters or digits SO-*       matches SO-980102, SO-A7
//
// Everything else is itself, letters in either case. A pattern matches a whole
// reference, never the middle of a longer one: PO-##### finds PO-00091 in
// "re: PO-00091 delivery" but not in "PO-000912", which is a different order.
// ---------------------------------------------------------------------------

const PATTERN_MAX_TOKENS = 80

function escapeRegex(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
}

/** What is wrong with a pattern, or null when it is usable. */
export function patternProblem(pattern: string): string | null {
  const trimmed = pattern.trim()
  if (trimmed.length < 2) return 'A pattern needs at least two characters.'
  if (trimmed.length > PATTERN_MAX_TOKENS) return 'That pattern is too long to be one reference.'
  if (/^[#@*\s]+$/.test(trimmed)) {
    return `“${trimmed}” would match nearly anything. Give it something fixed to hold on to, like PO- or INV.`
  }
  if (!/[#@*]/.test(trimmed) && trimmed.length < 3) return 'That pattern is too short to be a reference.'
  return null
}

/**
 * The pattern as a regular expression, matching whole references only. The
 * lookarounds rather than \b because a reference can begin or end with
 * punctuation (#12345), and \b has opinions about where words start.
 */
export function compilePattern(pattern: string, flags = 'i'): RegExp {
  let source = ''
  for (const char of pattern.trim()) {
    if (char === '#') source += '\\d'
    else if (char === '@') source += '[A-Za-z]'
    else if (char === '*') source += '[A-Za-z0-9]+'
    else if (/\s/.test(char)) source += '\\s+'
    else source += escapeRegex(char)
  }
  return new RegExp(`(?<![A-Za-z0-9])${source}(?![A-Za-z0-9])`, flags)
}

/** Every distinct reference the pattern finds in some text, in the order they
 *  appear, upper-cased so "po-00091" and "PO-00091" are one reference. */
export function findReferences(pattern: string, text: string | null | undefined, limit = 5): string[] {
  if (!text) return []
  const re = compilePattern(pattern, 'gi')
  const out: string[] = []
  for (const match of text.matchAll(re)) {
    const ref = match[0].toUpperCase()
    if (!out.includes(ref)) out.push(ref)
    if (out.length >= limit) break
  }
  return out
}

/** Whether a reference appears, whole, in some text. */
export function containsReference(text: string | null | undefined, reference: string): boolean {
  if (!text) return false
  const re = new RegExp(`(?<![A-Za-z0-9])${[...reference].map(escapeRegex).join('')}(?![A-Za-z0-9])`, 'i')
  return re.test(text)
}

/**
 * A pattern worked out from an example: `PO-00091` becomes `PO-#####`. Letters
 * that look like part of the fixed prefix stay as they are; runs of digits
 * become #s. What the screen offers when somebody pastes a real reference
 * instead of learning the notation.
 */
export function patternFromExample(example: string): string {
  return example.trim().replace(/\d/g, '#')
}

// ---------------------------------------------------------------------------
// Matching.
// ---------------------------------------------------------------------------

/** What a rule can see of a message. */
export type RuleMessage = {
  messageId: string
  threadId: string
  inboxId: string | null
  channel: string
  fromAddress: string | null
  fromName: string | null
  recipients: string[]
  subject: string | null
  bodyText: string | null
  hasAttachments: boolean
  /** Whether this message is the first in its conversation. */
  startsConversation: boolean
  /** True for mail the site itself sent (a purchase order going out, a reply
   *  typed in Outlook), false for mail that arrived. See actionsForMessage. */
  sent: boolean
}

/**
 * The steps of a rule that apply to this message.
 *
 * Everything, for mail that arrived. For mail the site sent, the merge and
 * nothing else - unless the rule says "mail the site sends too" (includeSent),
 * when it is everything again. That is for the site's own automatic mail
 * somebody wants out of the way: a login code or a security alert the site
 * emails a customer lands in the inbox as a sent conversation, and "mark it
 * done" is exactly what a rule for those should do. A merge is about which conversation a reference belongs with,
 * and that is the same question whoever wrote the email: a "payment sent for
 * PO-00093" going out as a brand-new email belongs under PO-00093 exactly as
 * the supplier's pro forma does. The other steps are about dealing with post
 * that has come in - assigning it, filing it, marking it done - and turning
 * them on for our own sent mail would have every existing rule quietly start
 * filing things nobody asked it to, which is why it is a box to tick.
 */
export function actionsForMessage(
  rule: Pick<RuleBody, 'actions'> & { includeSent?: boolean },
  message: Pick<RuleMessage, 'sent'>,
): RuleAction[] {
  if (!message.sent || rule.includeSent) return rule.actions
  return rule.actions.filter((a) => a.type === 'mergeByReference')
}

/**
 * Whose company a message is "from", for a merge's "same company": the
 * sender's address for mail that arrived, and for mail we sent the first
 * recipient who is not at our own domain - otherwise every conversation we
 * ever wrote on would count as the same company. Null when there is nobody
 * outside to go on (an email between two of our own addresses).
 */
export function counterpartyAddress(message: Pick<RuleMessage, 'sent' | 'fromAddress' | 'recipients'>): string | null {
  if (!message.sent) return bareAddress(message.fromAddress)
  const ours = domainOfAddress(message.fromAddress)
  for (const recipient of message.recipients) {
    const address = bareAddress(recipient)
    const domain = domainOfAddress(recipient)
    if (address && domain && domain !== ours) return address
  }
  return null
}

/** The bare address out of "Name <x@y>", lower case. */
export function bareAddress(value: string | null | undefined): string | null {
  if (!value) return null
  const angled = value.match(/<([^>]+)>/)
  const address = (angled?.[1] ?? value).trim().toLowerCase()
  return address || null
}

export function domainOfAddress(value: string | null | undefined): string | null {
  const address = bareAddress(value)
  if (!address) return null
  const at = address.lastIndexOf('@')
  if (at < 0 || at === address.length - 1) return null
  return address.slice(at + 1)
}

function fieldValues(field: TextField, message: RuleMessage): string[] {
  switch (field) {
    case 'from': return [bareAddress(message.fromAddress) ?? '']
    case 'fromDomain': return [domainOfAddress(message.fromAddress) ?? '']
    case 'fromName': return [message.fromName ?? '']
    case 'recipients': return message.recipients.map((r) => bareAddress(r) ?? r.toLowerCase())
    case 'subject': return [message.subject ?? '']
    case 'body': return [message.bodyText ?? '']
  }
}

function textMatches(op: TextOp, haystack: string, needle: string): boolean {
  const h = haystack.toLowerCase()
  const n = needle.trim().toLowerCase()
  switch (op) {
    case 'contains': return h.includes(n)
    case 'notContains': return !h.includes(n)
    case 'is': return h.trim() === n
    case 'isNot': return h.trim() !== n
    case 'startsWith': return h.trimStart().startsWith(n)
    case 'endsWith': return h.trimEnd().endsWith(n)
    case 'matches': return compilePattern(needle).test(haystack)
    case 'notMatches': return !compilePattern(needle).test(haystack)
  }
}

/** Whether "the domain is deskwell.co.uk" should also accept "@deskwell.co.uk"
 *  and "Deskwell.co.uk " - it should; people type all three. */
function normaliseNeedle(field: TextField, value: string): string {
  if (field === 'fromDomain') return value.trim().replace(/^@/, '')
  return value
}

export function conditionMatches(condition: RuleCondition, message: RuleMessage): boolean {
  switch (condition.field) {
    case 'inbox':
      return condition.op === 'is' ? message.inboxId === condition.value : message.inboxId !== condition.value
    case 'channel':
      return condition.op === 'is' ? message.channel === condition.value : message.channel !== condition.value
    case 'attachments':
      return condition.op === 'has' ? message.hasAttachments : !message.hasAttachments
    default: {
      const values = fieldValues(condition.field, message)
      const needle = normaliseNeedle(condition.field, condition.value)
      // A negative over a list ("no recipient is x") has to hold for every
      // value; a positive holds if any one does.
      const negative = condition.op === 'notContains' || condition.op === 'isNot' || condition.op === 'notMatches'
      if (values.length === 0) return negative
      return negative
        ? values.every((v) => textMatches(condition.op, v, needle))
        : values.some((v) => textMatches(condition.op, v, needle))
    }
  }
}

/**
 * Whether a rule applies to a message, before any action is weighed.
 *
 * A rule with no conditions applies to everything its trigger lets through -
 * "every new conversation in sales@ is Sam's" is one condition, but "every new
 * conversation is Sam's" is none, and both are reasonable things to want.
 */
export function ruleMatches(
  rule: Pick<RuleBody, 'trigger' | 'match' | 'conditions' | 'actions'> & { includeSent?: boolean },
  message: RuleMessage,
): boolean {
  if (rule.trigger === 'newConversation' && !message.startsConversation) return false
  // Mail we sent gets only a rule's merge unless the rule takes sent mail too
  // (actionsForMessage); a rule left with no steps has nothing to say about it.
  if (actionsForMessage(rule, message).length === 0) return false
  if (rule.conditions.length === 0) return true
  return rule.match === 'all'
    ? rule.conditions.every((c) => conditionMatches(c, message))
    : rule.conditions.some((c) => conditionMatches(c, message))
}

/** The references a merge action finds on a message. */
export function mergeReferences(action: Extract<RuleAction, { type: 'mergeByReference' }>, message: RuleMessage): string[] {
  const fromSubject = findReferences(action.pattern, message.subject)
  if (action.lookIn === 'subject') return fromSubject
  const out = [...fromSubject]
  for (const ref of findReferences(action.pattern, message.bodyText)) {
    if (!out.includes(ref)) out.push(ref)
  }
  return out.slice(0, 5)
}

// ---------------------------------------------------------------------------
// Words.
// ---------------------------------------------------------------------------

export const FIELD_LABELS: Record<RuleCondition['field'], string> = {
  from: 'Sender’s address',
  fromDomain: 'Sender’s domain',
  fromName: 'Sender’s name',
  recipients: 'Any recipient',
  subject: 'Subject',
  body: 'Message text',
  inbox: 'Arrived in',
  channel: 'Channel',
  attachments: 'Attachments',
}

export const OP_LABELS: Record<TextOp | 'has' | 'hasNone', string> = {
  contains: 'contains',
  notContains: 'does not contain',
  is: 'is',
  isNot: 'is not',
  startsWith: 'starts with',
  endsWith: 'ends with',
  matches: 'has a reference like',
  notMatches: 'has no reference like',
  has: 'has some',
  hasNone: 'has none',
}
