import { prisma } from '@/lib/db/prisma'
import { buildMessagePayload, readMessageRow } from './webhooks'
import { enqueueDeliveries, liveWebhooksForEvents } from './webhooks-db'
import type { ScopedWebhook } from './webhooks-db'
import type { ColleaguePayload, ColleaguePerson, WebhookEvent } from './webhook-types'

// ---------------------------------------------------------------------------
// Telling something else when a COLLEAGUE wants somebody.
//
// message.received answers "did post from outside land in this inbox". These
// three answer the question a person's own automation actually asks - "does
// somebody want me" - which post from outside is only one way of doing:
//
//   discussion.received    a note in an internal discussion that is put to the
//                          inbox's owner, or filed in the inbox.
//   mention.received       a note that tags somebody, on any conversation.
//   conversation.assigned  a colleague hands a conversation to somebody.
//
// A subscription is scoped to an inbox, and an inbox is not a person. The
// bridge is the one inbox kind that has one: an individual inbox belongs to
// its owner, so a subscription to Marcus's own inbox is a subscription to
// Marcus. How each scope reads:
//
//   every inbox   every discussion note, every ask, every hand-over.
//   individual    its owner addressed in a discussion, asked about anything,
//                 or handed anything - wherever the conversation lives.
//   shared        discussions filed in it, and its conversations handed to
//                 somebody. Nobody owns a shared address, so there is nobody
//                 to have asked - an ask goes to a person, and reaches them
//                 through their own inbox.
//
// NOBODY IS TOLD ABOUT THEIR OWN DOING. A note you wrote, a conversation you
// took yourself: an automation told about either is being told what its owner
// already knows. The same reasoning is why the automatic hand-overs - a
// conversation put on your desk because your own post started it, or because
// you asked to be reminded to chase it - never reach here at all: each one
// only ever gives somebody a conversation they started.
//
// ONE DELIVERY PER MESSAGE PER SUBSCRIPTION, WHATEVER THE EVENT. Two cases
// that would otherwise tell one endpoint the same thing twice:
//
//   - A discussion put to somebody is also an ask on their list (the discussion
//     route tags whoever is on its To line), so a subscription listening for
//     both would hear the same note twice. The discussion event wins and the
//     payload says the person was mentioned as well.
//
//   - Post arrives in Bob's inbox and his subscription is told. Seconds later a
//     colleague hands the conversation to Bob. The hand-over is keyed on the
//     same email, and the subscription already heard about that email, so it
//     is not told again. A NEW email and then a hand-over is the same story
//     one message later. The guard is the unique index on (webhook_id,
//     message_id) - migrations/057_webhook_once_per_message.sql - so two
//     requests racing cannot both get through.
//
// Queued like any arrival and sent by the same scheduled tick - a colleague
// writing a note or handing something over must never wait on somebody else's
// endpoint.
// ---------------------------------------------------------------------------

const NOTE_EVENTS: WebhookEvent[] = ['discussion.received', 'mention.received']

export type NoteContext = {
  /** Whoever wrote the note. Never told about their own note. */
  authorUserId: string | null
  /** Whether the conversation is an internal discussion. */
  isDiscussion: boolean
  /** Who the discussion is between: whoever started it and whoever it was put
   *  to. Empty on anything that is not a discussion. */
  parties: string[]
  /** Who this note tagged, as they were actually asked. */
  asked: string[]
  /** Every address the conversation is filed under. */
  filedInboxIds: string[]
}

export type PlannedDelivery = {
  scoped: ScopedWebhook
  event: 'discussion.received' | 'mention.received' | 'conversation.assigned'
  /** The colleagues this delivery is about. */
  userIds: string[]
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])]
}

/** Whether a subscription scoped to one address covers a conversation filed
 *  under it. */
function filedIn(scoped: ScopedWebhook, filedInboxIds: string[]): boolean {
  return scoped.hook.inboxId !== null && filedInboxIds.includes(scoped.hook.inboxId)
}

/**
 * Which subscriptions hear about one note, as which event, about whom.
 *
 * Pure and exported for the tests: both ways of getting it wrong are silent.
 * Too few and somebody's automation never hears it was wanted; too many and it
 * hears about a colleague's private discussion it was never part of.
 */
export function planNoteDeliveries(hooks: ScopedWebhook[], ctx: NoteContext): PlannedDelivery[] {
  const author = ctx.authorUserId
  const parties = ctx.parties.filter((id) => id !== author)
  const asked = ctx.asked.filter((id) => id !== author)
  const everybody = union(parties, asked)

  const out: PlannedDelivery[] = []
  for (const scoped of hooks) {
    const { hook, inboxKind, ownerUserId } = scoped

    if (ctx.isDiscussion && hook.events.includes('discussion.received')) {
      let userIds: string[] | null = null
      if (inboxKind === null) {
        userIds = everybody
      } else if (inboxKind === 'individual') {
        // Their own post: they are on it, or it was filed in their inbox by
        // somebody else. Their own note in their own inbox is them talking.
        if (ownerUserId && ownerUserId !== author && (parties.includes(ownerUserId) || filedIn(scoped, ctx.filedInboxIds))) {
          userIds = [ownerUserId]
        }
      } else if (filedIn(scoped, ctx.filedInboxIds)) {
        userIds = everybody
      }
      if (userIds) {
        out.push({ scoped, event: 'discussion.received', userIds })
        continue
      }
    }

    if (asked.length > 0 && hook.events.includes('mention.received')) {
      if (inboxKind === null) {
        out.push({ scoped, event: 'mention.received', userIds: asked })
      } else if (inboxKind === 'individual' && ownerUserId && asked.includes(ownerUserId)) {
        out.push({ scoped, event: 'mention.received', userIds: [ownerUserId] })
      }
    }
  }
  return out
}

export type AssignmentContext = {
  /** Who it was handed to. Null is a hand-back to nobody, which tells no one. */
  assigneeUserId: string | null
  /** Who handed it over. */
  byUserId: string | null
  /** Every address the conversation is filed under. */
  filedInboxIds: string[]
}

/** Which subscriptions hear that a conversation was handed to somebody. Pure,
 *  for the same reason as the note half. */
export function planAssignmentDeliveries(hooks: ScopedWebhook[], ctx: AssignmentContext): PlannedDelivery[] {
  const assignee = ctx.assigneeUserId
  if (!assignee || assignee === ctx.byUserId) return []

  const out: PlannedDelivery[] = []
  for (const scoped of hooks) {
    if (!scoped.hook.events.includes('conversation.assigned')) continue
    const reaches = scoped.inboxKind === null
      || (scoped.inboxKind === 'individual' && scoped.ownerUserId === assignee)
      || (scoped.inboxKind === 'shared' && filedIn(scoped, ctx.filedInboxIds))
    if (reaches) out.push({ scoped, event: 'conversation.assigned', userIds: [assignee] })
  }
  return out
}

/**
 * Called once for each note a colleague has just written, after the asks on it
 * have been recorded.
 *
 * Swallows its own errors for the same reason queueMessageWebhooks does: the
 * note is saved, the colleague has been asked, and an endpoint not being told
 * is something the settings screen shows rather than something that should
 * fail the note.
 */
export async function queueNoteWebhooks(messageId: string, askedUserIds: string[]): Promise<number> {
  try {
    const hooks = await liveWebhooksForEvents(NOTE_EVENTS)
    if (hooks.length === 0) return 0

    const row = await readMessageRow(messageId)
    if (!row || row.direction !== 'note') return 0

    const isDiscussion = row.thread_channel === 'discussion'
    const startedBy = (row.started_by_user_id as string | null) ?? null
    const toUserIds = (row.to_user_ids as string[] | null) ?? []
    const parties = isDiscussion ? union(startedBy ? [startedBy] : [], toUserIds) : []
    const authorId = (row.author_user_id as string | null) ?? null

    const plan = planNoteDeliveries(hooks, {
      authorUserId: authorId,
      isDiscussion,
      parties,
      asked: askedUserIds,
      filedInboxIds: (row.filed_inbox_ids as string[] | null) ?? [],
    })

    return await enqueuePlan(plan, row, {
      byUserId: authorId,
      // A note has no envelope of its own; its sender is the colleague who
      // wrote it, and their address is the one that says who.
      senderIsBy: true,
      why: (id) => ({ addressed: parties.includes(id), mentioned: askedUserIds.includes(id), assigned: false }),
    })
  } catch (error) {
    console.error('[unified-inbox] could not queue webhooks for a note', error)
    return 0
  }
}

/**
 * Called when a colleague hands a conversation to somebody from the screen.
 *
 * The envelope is the newest message on the conversation that is not a note -
 * the post being handed over, with its own sender - so an automation reading
 * `message.from` learns who wrote in, not who passed it on. `by` says that.
 *
 * And it is keyed on that message, so a subscription already told about it -
 * because it arrived in the inbox a moment ago, or because it was handed over
 * once already - hears nothing new. Handed over, handed back and handed over
 * again with no post in between is one thing to tell, not three.
 */
export async function queueAssignmentWebhooks(input: {
  threadId: string
  assigneeUserId: string | null
  byUserId: string
}): Promise<number> {
  try {
    if (!input.assigneeUserId || input.assigneeUserId === input.byUserId) return 0
    const hooks = await liveWebhooksForEvents(['conversation.assigned'])
    if (hooks.length === 0) return 0

    // Post before notes, newest first. A conversation of nothing but notes - a
    // discussion - is still worth naming, so a note will do when it is all
    // there is. A conversation with no messages at all has nothing to say.
    const newest = await prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "uin_messages"
       WHERE "thread_id" = ${input.threadId}
       ORDER BY ("direction" = 'note') ASC, "sent_at" DESC
       LIMIT 1
    `
    const messageId = newest[0]?.id
    if (!messageId) return 0
    const row = await readMessageRow(messageId)
    if (!row) return 0

    const plan = planAssignmentDeliveries(hooks, {
      assigneeUserId: input.assigneeUserId,
      byUserId: input.byUserId,
      filedInboxIds: (row.filed_inbox_ids as string[] | null) ?? [],
    })

    return await enqueuePlan(plan, row, {
      byUserId: input.byUserId,
      senderIsBy: row.direction === 'note',
      why: () => ({ addressed: false, mentioned: false, assigned: true }),
    })
  } catch (error) {
    console.error('[unified-inbox] could not queue webhooks for a hand-over', error)
    return 0
  }
}

async function enqueuePlan(
  plan: PlannedDelivery[],
  row: Record<string, unknown>,
  how: {
    byUserId: string | null
    senderIsBy: boolean
    why: (userId: string) => Pick<ColleaguePerson, 'addressed' | 'mentioned' | 'assigned'>
  },
): Promise<number> {
  if (plan.length === 0) return 0

  const people = await readPeople(union(
    plan.flatMap((one) => one.userIds),
    how.byUserId ? [how.byUserId] : [],
  ))
  const person = (id: string) => people.get(id) ?? { name: null, email: null }
  const by = how.byUserId ? person(how.byUserId) : { name: null, email: null }
  const messageId = row.message_id as string
  const threadId = row.thread_id as string

  return enqueueDeliveries(plan.map(({ scoped, event, userIds }) => {
    const hook = scoped.hook
    // Keyed on the message, always: that is what stops an endpoint already told
    // about this email being told again when it is handed over.
    const envelope = { webhookId: hook.id, event, messageId, threadId }
    if (hook.payloadStyle === 'literal') return { ...envelope, payload: { style: 'literal' as const } }

    const base = buildMessagePayload(row, hook)
    const body: ColleaguePayload = {
      ...base,
      event,
      message: how.senderIsBy
        ? { ...base.message, from: { name: by.name, address: by.email, phone: null } }
        : base.message,
      by: { id: how.byUserId ?? '', name: by.name, email: by.email },
      for: userIds.map((id): ColleaguePerson => ({ id, ...person(id), ...how.why(id) })),
    }
    return { ...envelope, payload: { style: 'event' as const, body } }
  }))
}

async function readPeople(ids: string[]): Promise<Map<string, { name: string | null; email: string | null }>> {
  if (ids.length === 0) return new Map()
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, displayName: true, username: true, email: true },
  })
  return new Map(users.map((u) => [u.id, { name: u.displayName || u.username, email: u.email }]))
}
