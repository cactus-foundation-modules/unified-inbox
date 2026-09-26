import { describe, it, expect } from 'vitest'
import { planAssignmentDeliveries, planNoteDeliveries } from './colleague-webhooks'
import type { NoteContext } from './colleague-webhooks'
import type { ScopedWebhook } from './webhooks-db'
import type { Webhook, WebhookEvent } from './webhook-types'

// Who hears about a colleague's note. Both ways of getting it wrong are silent:
// somebody's automation never told they were wanted, or told about a private
// discussion it was never part of.

function scoped(
  id: string,
  events: WebhookEvent[],
  scope: { inboxId: string | null; kind: 'individual' | 'shared' | null; owner?: string | null },
): ScopedWebhook {
  const hook: Webhook = {
    id,
    name: id,
    inboxId: scope.inboxId,
    url: 'https://example.com/hook',
    enabled: true,
    events,
    payloadStyle: 'event',
    literalBody: null,
    includeBody: false,
    hasSecret: false,
    hasHeaders: false,
    secretSource: 'none',
    headersSource: 'none',
    lastStatus: null,
    lastAttemptAt: null,
    lastError: null,
    consecutiveFailures: 0,
    autoDisabledAt: null,
    createdAt: new Date(),
  }
  return { hook, inboxKind: scope.kind, ownerUserId: scope.owner ?? null }
}

const BOTH: WebhookEvent[] = ['discussion.received', 'mention.received']

// Chris writes. Bob owns bob-inbox, Carol owns carol-inbox, sales is shared.
const bob = (events: WebhookEvent[] = BOTH) => scoped('bob', events, { inboxId: 'bob-inbox', kind: 'individual', owner: 'bob' })
const carol = (events: WebhookEvent[] = BOTH) => scoped('carol', events, { inboxId: 'carol-inbox', kind: 'individual', owner: 'carol' })
const chris = (events: WebhookEvent[] = BOTH) => scoped('chris', events, { inboxId: 'chris-inbox', kind: 'individual', owner: 'chris' })
const sales = (events: WebhookEvent[] = BOTH) => scoped('sales', events, { inboxId: 'sales', kind: 'shared' })
const every = (events: WebhookEvent[] = BOTH) => scoped('every', events, { inboxId: null, kind: null })

function ctx(over: Partial<NoteContext> = {}): NoteContext {
  return {
    authorUserId: 'chris',
    isDiscussion: false,
    parties: [],
    asked: [],
    filedInboxIds: ['sales'],
    ...over,
  }
}

function summary(plan: ReturnType<typeof planNoteDeliveries>) {
  return plan.map((one) => `${one.scoped.hook.id}:${one.event}:${one.userIds.join('+')}`)
}

describe('planNoteDeliveries', () => {
  it('tells the owner of an inbox when a discussion is put to them, once', () => {
    // The discussion route asks whoever is on the To line as well, so Bob is
    // both addressed and asked - and still hears it once.
    const plan = planNoteDeliveries([bob(), carol(), chris()], ctx({
      isDiscussion: true,
      parties: ['chris', 'bob'],
      asked: ['bob'],
      filedInboxIds: ['chris-inbox', 'bob-inbox'],
    }))
    expect(summary(plan)).toEqual(['bob:discussion.received:bob'])
  })

  it('never tells the author about their own note', () => {
    const plan = planNoteDeliveries([chris(), every()], ctx({
      isDiscussion: true,
      parties: ['chris'],
      asked: ['chris'],
      filedInboxIds: ['chris-inbox'],
    }))
    expect(summary(plan)).toEqual(['every:discussion.received:'])
  })

  it('tells the starter when somebody answers their discussion', () => {
    const plan = planNoteDeliveries([chris(), bob()], ctx({
      authorUserId: 'bob',
      isDiscussion: true,
      parties: ['chris', 'bob'],
      filedInboxIds: ['chris-inbox', 'bob-inbox'],
    }))
    expect(summary(plan)).toEqual(['chris:discussion.received:chris'])
  })

  it('tells somebody tagged in an email conversation, through their own inbox', () => {
    const plan = planNoteDeliveries([bob(), carol(), sales()], ctx({ asked: ['carol'] }))
    expect(summary(plan)).toEqual(['carol:mention.received:carol'])
  })

  it('tells somebody tagged in a discussion they are not part of as an ask', () => {
    const plan = planNoteDeliveries([bob(), carol()], ctx({
      isDiscussion: true,
      parties: ['chris', 'bob'],
      asked: ['bob', 'carol'],
      filedInboxIds: ['chris-inbox', 'bob-inbox'],
    }))
    expect(summary(plan)).toEqual(['bob:discussion.received:bob', 'carol:mention.received:carol'])
  })

  it('says nothing to a subscription that did not ask for that event', () => {
    const plan = planNoteDeliveries(
      [bob(['message.received']), carol(['discussion.received'])],
      ctx({ asked: ['bob', 'carol'] }),
    )
    expect(plan).toEqual([])
  })

  it('tells a shared inbox about discussions filed in it, but never about asks', () => {
    expect(summary(planNoteDeliveries([sales()], ctx({
      isDiscussion: true,
      parties: ['chris', 'bob'],
      filedInboxIds: ['sales', 'bob-inbox'],
    })))).toEqual(['sales:discussion.received:bob'])

    expect(planNoteDeliveries([sales()], ctx({ asked: ['bob'] }))).toEqual([])
  })

  it('keeps a discussion filed elsewhere away from a shared inbox', () => {
    const plan = planNoteDeliveries([sales()], ctx({
      isDiscussion: true,
      parties: ['chris', 'bob'],
      filedInboxIds: ['chris-inbox', 'bob-inbox'],
    }))
    expect(plan).toEqual([])
  })

  it('tells every-inbox subscriptions about everybody asked', () => {
    const plan = planNoteDeliveries([every()], ctx({ asked: ['bob', 'carol'] }))
    expect(summary(plan)).toEqual(['every:mention.received:bob+carol'])
  })

  it('treats a plain note with nobody tagged as nothing to tell', () => {
    expect(planNoteDeliveries([bob(), every(), sales()], ctx())).toEqual([])
  })
})

describe('planAssignmentDeliveries', () => {
  const ASSIGN: WebhookEvent[] = ['conversation.assigned']
  const handed = (assigneeUserId: string | null, byUserId = 'chris') => ({
    assigneeUserId, byUserId, filedInboxIds: ['sales'],
  })

  it('tells the owner of an inbox when a conversation is handed to them', () => {
    const plan = planAssignmentDeliveries([bob(ASSIGN), carol(ASSIGN)], handed('bob'))
    expect(summary(plan)).toEqual(['bob:conversation.assigned:bob'])
  })

  it('tells every inbox, and the shared inbox the conversation is filed in', () => {
    const plan = planAssignmentDeliveries([every(ASSIGN), sales(ASSIGN)], handed('bob'))
    expect(summary(plan)).toEqual(['every:conversation.assigned:bob', 'sales:conversation.assigned:bob'])
  })

  it('keeps a hand-over away from a shared inbox the conversation is not in', () => {
    const plan = planAssignmentDeliveries([sales(ASSIGN)], { ...handed('bob'), filedInboxIds: ['support'] })
    expect(plan).toEqual([])
  })

  it('says nothing about taking a conversation yourself, or handing it to nobody', () => {
    expect(planAssignmentDeliveries([chris(ASSIGN), every(ASSIGN)], handed('chris'))).toEqual([])
    expect(planAssignmentDeliveries([every(ASSIGN)], handed(null))).toEqual([])
  })

  it('says nothing to a subscription that did not ask for hand-overs', () => {
    expect(planAssignmentDeliveries([bob(BOTH), bob(['message.received'])], handed('bob'))).toEqual([])
  })
})
