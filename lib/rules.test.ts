import { describe, it, expect } from 'vitest'
import {
  RuleBody,
  compilePattern,
  conditionMatches,
  containsReference,
  findReferences,
  mergeReferences,
  patternFromExample,
  patternProblem,
  ruleMatches,
  ruleProblem,
  type RuleMessage,
} from './rules'

const supplierReply: RuleMessage = {
  messageId: 'm1',
  threadId: 't1',
  inboxId: 'chris-inbox',
  channel: 'email',
  fromAddress: 'faye.whitmore@supplier.example',
  fromName: 'Faye Whitmore',
  recipients: ['chris@shop.example'],
  subject: 'Sales Order 0000980102 - PO-00091',
  bodyText: 'Thank you for placing your order with us.',
  hasAttachments: true,
  startsConversation: true,
}

const mergeRule = (over: Partial<RuleBody> = {}): RuleBody => ({
  name: 'Supplier replies to purchase orders',
  enabled: true,
  trigger: 'newConversation',
  match: 'all',
  conditions: [{ id: 'c1', field: 'subject', op: 'matches', value: 'PO-#####' }],
  actions: [{ type: 'mergeByReference', pattern: 'PO-#####', lookIn: 'subject', sameCompany: true, withinDays: 60 }],
  stopProcessing: false,
  ...over,
})

describe('the pattern language', () => {
  it('reads # as a digit, @ as a letter and * as a run of either', () => {
    expect(compilePattern('PO-#####').test('PO-00091')).toBe(true)
    expect(compilePattern('@@-####').test('AB-1234')).toBe(true)
    expect(compilePattern('SO-*').test('SO-A7x9')).toBe(true)
    expect(compilePattern('PO-#####').test('PO-0009')).toBe(false)
  })

  it('matches whole references only, never the middle of a longer one', () => {
    expect(compilePattern('PO-#####').test('PO-000912')).toBe(false)
    expect(compilePattern('PO-#####').test('XPO-00091')).toBe(false)
    expect(compilePattern('PO-#####').test('re: PO-00091, delivery')).toBe(true)
  })

  it('ignores case, and treats regex characters as themselves', () => {
    expect(compilePattern('po-#####').test('PO-00091')).toBe(true)
    expect(compilePattern('INV.###').test('INV.123')).toBe(true)
    expect(compilePattern('INV.###').test('INVX123')).toBe(false)
    expect(compilePattern('(#)').test('(4)')).toBe(true)
  })

  it('finds every distinct reference, upper-cased, in order', () => {
    expect(findReferences('PO-#####', 'po-00091 and PO-00092 and PO-00091 again')).toEqual(['PO-00091', 'PO-00092'])
    expect(findReferences('PO-#####', null)).toEqual([])
  })

  it('knows a reference when it sees it whole', () => {
    expect(containsReference('Purchase order PO-00091 from Us', 'PO-00091')).toBe(true)
    expect(containsReference('Purchase order PO-000912 from Us', 'PO-00091')).toBe(false)
  })

  it('refuses patterns that would match nearly anything', () => {
    expect(patternProblem('#####')).toMatch(/nearly anything/)
    expect(patternProblem('*')).not.toBeNull()
    expect(patternProblem('PO-#####')).toBeNull()
  })

  it('works a pattern out from an example', () => {
    expect(patternFromExample(' PO-00091 ')).toBe('PO-#####')
    expect(patternFromExample('INV/2026/14')).toBe('INV/####/##')
  })
})

describe('conditions', () => {
  it('compares text without minding case', () => {
    expect(conditionMatches({ id: 'a', field: 'fromDomain', op: 'is', value: 'Supplier.Example' }, supplierReply)).toBe(true)
    expect(conditionMatches({ id: 'a', field: 'fromDomain', op: 'is', value: '@supplier.example' }, supplierReply)).toBe(true)
    expect(conditionMatches({ id: 'a', field: 'subject', op: 'startsWith', value: 'sales order' }, supplierReply)).toBe(true)
    expect(conditionMatches({ id: 'a', field: 'subject', op: 'notContains', value: 'invoice' }, supplierReply)).toBe(true)
  })

  it('reads an address out of "Name <x@y>"', () => {
    const message = { ...supplierReply, fromAddress: 'Faye <Faye.Whitmore@Supplier.example>' }
    expect(conditionMatches({ id: 'a', field: 'from', op: 'is', value: 'faye.whitmore@supplier.example' }, message)).toBe(true)
  })

  it('holds a positive over recipients if any one matches, a negative only if all do', () => {
    const message = { ...supplierReply, recipients: ['chris@shop.example', 'Sales <sales@shop.example>'] }
    expect(conditionMatches({ id: 'a', field: 'recipients', op: 'is', value: 'sales@shop.example' }, message)).toBe(true)
    expect(conditionMatches({ id: 'a', field: 'recipients', op: 'isNot', value: 'sales@shop.example' }, message)).toBe(false)
  })

  it('handles mailbox, channel and attachments', () => {
    expect(conditionMatches({ id: 'a', field: 'inbox', op: 'is', value: 'chris-inbox' }, supplierReply)).toBe(true)
    expect(conditionMatches({ id: 'a', field: 'channel', op: 'isNot', value: 'email' }, supplierReply)).toBe(false)
    expect(conditionMatches({ id: 'a', field: 'attachments', op: 'has', value: '' }, supplierReply)).toBe(true)
  })
})

describe('rules', () => {
  it('lets a "new conversation" rule see only the message that started one', () => {
    expect(ruleMatches(mergeRule(), supplierReply)).toBe(true)
    expect(ruleMatches(mergeRule(), { ...supplierReply, startsConversation: false })).toBe(false)
    expect(ruleMatches(mergeRule({ trigger: 'everyMessage' }), { ...supplierReply, startsConversation: false })).toBe(true)
  })

  it('applies all-or-any as written, and a rule with no conditions to everything', () => {
    const conditions = [
      { id: 'a', field: 'subject' as const, op: 'contains' as const, value: 'invoice' },
      { id: 'b', field: 'fromDomain' as const, op: 'is' as const, value: 'supplier.example' },
    ]
    expect(ruleMatches(mergeRule({ conditions, match: 'all' }), supplierReply)).toBe(false)
    expect(ruleMatches(mergeRule({ conditions, match: 'any' }), supplierReply)).toBe(true)
    expect(ruleMatches(mergeRule({ conditions: [] }), supplierReply)).toBe(true)
  })

  it('finds the references a merge should look for', () => {
    const action = mergeRule().actions[0]
    if (action?.type !== 'mergeByReference') throw new Error('expected a merge')
    expect(mergeReferences(action, supplierReply)).toEqual(['PO-00091'])
    expect(mergeReferences({ ...action, lookIn: 'subjectOrBody' }, { ...supplierReply, subject: 'Your order', bodyText: 'Re PO-00092' }))
      .toEqual(['PO-00092'])
  })

  it('refuses a merge on a rule that runs on every message, and the same step twice', () => {
    expect(ruleProblem(mergeRule({ trigger: 'everyMessage' }))).toMatch(/new conversation/)
    expect(ruleProblem(mergeRule({ actions: [{ type: 'markRead' }, { type: 'markRead' }] }))).toMatch(/twice/)
    expect(ruleProblem(mergeRule({ actions: [{ type: 'markDone' }, { type: 'snooze', days: 2 }] }))).toMatch(/not both/)
    expect(ruleProblem(mergeRule())).toBeNull()
  })

  it('validates the stored shape', () => {
    expect(RuleBody.safeParse(mergeRule()).success).toBe(true)
    expect(RuleBody.safeParse({ ...mergeRule(), actions: [] }).success).toBe(false)
    expect(RuleBody.safeParse({ ...mergeRule(), conditions: [{ id: 'x', field: 'subject', op: 'sounds like', value: 'x' }] }).success).toBe(false)
  })
})
