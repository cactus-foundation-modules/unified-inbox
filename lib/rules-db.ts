import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import {
  RuleAction,
  RuleCondition,
  RULE_TRIGGERS,
  type RuleBody,
  type RuleMessage,
  type RuleTrigger,
  type StoredRule,
} from './rules'

// ---------------------------------------------------------------------------
// Where rules are kept, and the queries the engine asks while running them.
// See lib/rules.ts for what a rule is and migrations/078_rules.sql for why the
// tables look the way they do.
// ---------------------------------------------------------------------------

const Conditions = z.array(RuleCondition)
const Actions = z.array(RuleAction)

/** A rule as stored, plus whether it still reads. A rule written by an older
 *  version of the module that this one cannot make sense of is shown and
 *  never run - guessing what it meant is how mail ends up somewhere odd. */
export type RuleRow = StoredRule & { unreadable: boolean }

function mapRule(r: Record<string, unknown>): RuleRow {
  const conditions = Conditions.safeParse(r.conditions)
  const actions = Actions.safeParse(r.actions)
  const trigger = RULE_TRIGGERS.includes(r.trigger as RuleTrigger) ? (r.trigger as RuleTrigger) : null
  const unreadable = !conditions.success || !actions.success || !trigger
    || (r.match_mode !== 'all' && r.match_mode !== 'any')
  return {
    id: r.id as string,
    name: r.name as string,
    enabled: !!r.enabled,
    position: Number(r.position ?? 0),
    trigger: trigger ?? 'newConversation',
    match: r.match_mode === 'any' ? 'any' : 'all',
    conditions: conditions.success ? conditions.data : [],
    actions: actions.success ? actions.data : [],
    stopProcessing: !!r.stop_processing,
    fireCount: Number(r.fire_count ?? 0),
    lastFiredAt: (r.last_fired_at as Date | null) ?? null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
    unreadable,
  }
}

const RULE_COLUMNS = Prisma.sql`
  "id", "name", "enabled", "position", "trigger", "match_mode", "conditions", "actions",
  "stop_processing", "fire_count", "last_fired_at", "created_at", "updated_at"
`

export async function listRules(): Promise<RuleRow[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT ${RULE_COLUMNS} FROM "uin_rules" ORDER BY "position" ASC, "created_at" ASC
  `
  return rows.map(mapRule)
}

export async function getRule(id: string): Promise<RuleRow | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT ${RULE_COLUMNS} FROM "uin_rules" WHERE "id" = ${id}
  `
  return rows[0] ? mapRule(rows[0]) : null
}

export async function countRules(): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM "uin_rules"`
  return rows[0]?.n ?? 0
}

/**
 * The switched-on rules, in order, as the engine wants them.
 *
 * Remembered for a few seconds, because the collecting pass asks once per
 * message and a busy morning is a few hundred messages; every write below
 * forgets it at once, so a rule saved on the Rules tab is in force for the
 * very next message collected by this process.
 */
let enabledCache: { at: number; rules: RuleRow[] } | null = null
const ENABLED_CACHE_MS = 10_000

export async function enabledRules(): Promise<RuleRow[]> {
  if (enabledCache && Date.now() - enabledCache.at < ENABLED_CACHE_MS) return enabledCache.rules
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT ${RULE_COLUMNS} FROM "uin_rules"
     WHERE "enabled" = true
     ORDER BY "position" ASC, "created_at" ASC
  `
  const rules = rows.map(mapRule).filter((r) => !r.unreadable)
  enabledCache = { at: Date.now(), rules }
  return rules
}

export function forgetEnabledRules(): void {
  enabledCache = null
}

export async function createRule(body: RuleBody, userId: string | null): Promise<RuleRow> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    INSERT INTO "uin_rules"
      ("name", "enabled", "position", "trigger", "match_mode", "conditions", "actions",
       "stop_processing", "created_by", "updated_by")
    VALUES (
      ${body.name}, ${body.enabled},
      (SELECT COALESCE(MAX("position"), -1) + 1 FROM "uin_rules"),
      ${body.trigger}, ${body.match},
      ${JSON.stringify(body.conditions)}::jsonb, ${JSON.stringify(body.actions)}::jsonb,
      ${body.stopProcessing}, ${userId}, ${userId}
    )
    RETURNING ${RULE_COLUMNS}
  `
  forgetEnabledRules()
  return mapRule(rows[0]!)
}

export async function updateRule(id: string, body: RuleBody, userId: string | null): Promise<RuleRow | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    UPDATE "uin_rules"
       SET "name" = ${body.name},
           "enabled" = ${body.enabled},
           "trigger" = ${body.trigger},
           "match_mode" = ${body.match},
           "conditions" = ${JSON.stringify(body.conditions)}::jsonb,
           "actions" = ${JSON.stringify(body.actions)}::jsonb,
           "stop_processing" = ${body.stopProcessing},
           "updated_by" = ${userId},
           "updated_at" = CURRENT_TIMESTAMP
     WHERE "id" = ${id}
    RETURNING ${RULE_COLUMNS}
  `
  forgetEnabledRules()
  return rows[0] ? mapRule(rows[0]) : null
}

export async function setRuleEnabled(id: string, enabled: boolean, userId: string | null): Promise<boolean> {
  const changed = await prisma.$executeRaw`
    UPDATE "uin_rules"
       SET "enabled" = ${enabled}, "updated_by" = ${userId}, "updated_at" = CURRENT_TIMESTAMP
     WHERE "id" = ${id}
  `
  forgetEnabledRules()
  return changed > 0
}

export async function deleteRule(id: string): Promise<boolean> {
  const removed = await prisma.$executeRaw`DELETE FROM "uin_rules" WHERE "id" = ${id}`
  forgetEnabledRules()
  return removed > 0
}

/** Put the rules in the order given. Ids not named keep their place after the
 *  named ones, so a list that changed under somebody's feet loses nothing. */
export async function reorderRules(ids: string[]): Promise<void> {
  await prisma.$transaction(async (tx) => {
    for (const [index, id] of ids.entries()) {
      await tx.$executeRaw`UPDATE "uin_rules" SET "position" = ${index} WHERE "id" = ${id}`
    }
    await tx.$executeRaw`
      UPDATE "uin_rules" SET "position" = ${ids.length} + "position"
       WHERE NOT ("id" = ANY(${ids}::text[]))
    `
  })
  forgetEnabledRules()
}

// ---------------------------------------------------------------------------
// What a rule sees of a message.
// ---------------------------------------------------------------------------

/** The messages a rule may read, as a WHERE clause over `m` (uin_messages)
 *  joined to `t` (its uin_threads row). One definition, so the live run, "run
 *  on recent mail" and the preview can never disagree about what they see. */
const RULE_READABLE = Prisma.sql`(
  (m."direction" = 'in' OR (m."direction" = 'out' AND m."delivery_status" IS DISTINCT FROM 'failed'))
  AND m."auto_kind" IS NULL
  AND t."merged_into_id" IS NULL
)`

/**
 * One message in the shape a rule reads, or null when it is not one a rule
 * should see: gone, a note, an automatic message (a bounce, a newsletter
 * header), a send that failed, or on a conversation that has itself been
 * merged away. Mail we sent is seen, flagged `sent` - what a rule may do to
 * it is decided in lib/rules.ts (actionsForMessage).
 *
 * "Starts its conversation" means nothing earlier on the same conversation
 * other than notes - read live rather than taken from how the message was
 * filed, so "run on recent mail" over a fortnight answers the same question
 * the collecting pass answered on the day.
 */
export async function loadRuleMessage(messageId: string): Promise<RuleMessage | null> {
  return (await loadRuleMessages([messageId]))[0] ?? null
}

/** Several at once, in the order asked for, leaving out any a rule should not
 *  see. One query, so the preview reading a few hundred is one round trip. */
export async function loadRuleMessages(messageIds: string[]): Promise<RuleMessage[]> {
  if (messageIds.length === 0) return []
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT m."id", m."thread_id", m."direction", m."from_address", m."from_name", m."to_addresses", m."cc_addresses",
           m."subject", m."body_text", m."has_attachments",
           t."inbox_id", t."channel",
           NOT EXISTS (
             SELECT 1 FROM "uin_messages" e
              WHERE e."thread_id" = m."thread_id"
                AND e."id" <> m."id"
                AND e."direction" <> 'note'
                AND (e."sent_at", e."created_at") < (m."sent_at", m."created_at")
           ) AS starts
      FROM "uin_messages" m
      JOIN "uin_threads" t ON t."id" = m."thread_id"
     WHERE m."id" = ANY(${messageIds}::text[])
       AND ${RULE_READABLE}
       AND t."merged_into_id" IS NULL
  `
  const byId = new Map(rows.map((r) => [r.id as string, r]))
  const out: RuleMessage[] = []
  for (const id of messageIds) {
    const r = byId.get(id)
    if (!r) continue
    out.push({
      messageId: r.id as string,
      threadId: r.thread_id as string,
      inboxId: (r.inbox_id as string | null) ?? null,
      channel: r.channel as string,
      fromAddress: (r.from_address as string | null) ?? null,
      fromName: (r.from_name as string | null) ?? null,
      recipients: [...((r.to_addresses as string[] | null) ?? []), ...((r.cc_addresses as string[] | null) ?? [])],
      subject: (r.subject as string | null) ?? null,
      bodyText: (r.body_text as string | null) ?? null,
      hasAttachments: !!r.has_attachments,
      startsConversation: !!r.starts,
      sent: r.direction === 'out',
    })
  }
  return out
}

/**
 * Messages from the last `days`, oldest first, one page at a time -
 * what "run on recent mail" walks. Oldest first so that a merge rule finds
 * each conversation's partner already in place, rather than merging a reply
 * into something that was itself about to be merged.
 */
export async function recentRuleMessageIds(
  days: number,
  after: string | null,
  limit: number,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT m."id"
      FROM "uin_messages" m
      JOIN "uin_threads" t ON t."id" = m."thread_id"
     WHERE ${RULE_READABLE}
       AND m."created_at" >= now() - (${days} * interval '1 day')
       AND (
         ${after}::text IS NULL
         OR (m."sent_at", m."id") > (SELECT a."sent_at", a."id" FROM "uin_messages" a WHERE a."id" = ${after})
       )
     ORDER BY m."sent_at" ASC, m."id" ASC
     LIMIT ${limit}
  `
  return rows.map((r) => r.id)
}

/** The newest messages first, for the preview - which wants to show
 *  what a rule would have done lately, not in mid-September. */
export async function newestRuleMessageIds(days: number, limit: number): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT m."id"
      FROM "uin_messages" m
      JOIN "uin_threads" t ON t."id" = m."thread_id"
     WHERE ${RULE_READABLE}
       AND m."created_at" >= now() - (${days} * interval '1 day')
     ORDER BY m."sent_at" DESC, m."id" DESC
     LIMIT ${limit}
  `
  return rows.map((r) => r.id)
}

// ---------------------------------------------------------------------------
// Finding the conversation a merge belongs with.
// ---------------------------------------------------------------------------

/** LIKE treats % and _ as wildcards and \ as the escape. A reference or a
 *  domain carrying one must mean the character itself. */
function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** The same for a Postgres regular expression: every character that means
 *  something there stands for itself. */
function regexEscape(value: string): string {
  return value.replace(/[.^$*+?()[\]{}|\\-]/g, (c) => `\\${c}`)
}

export type MergeTarget = { id: string; subject: string | null; createdAt: Date }

/**
 * The earlier conversation carrying the same reference, or null.
 *
 * Earlier means STARTED earlier than the conversation being merged, which is
 * what stops two rules - or one rule run twice - from merging A into B and B
 * into A. The oldest of the candidates wins, the same rule a merge by hand
 * follows (see pickWinner in lib/thread-merge.ts).
 *
 * Where the reference is looked for on the candidate follows the rule's own
 * "look for it in": the subject (its own, or any message's), or the subject
 * or the text of any message on it. Both sides are searched the same way, so a
 * rule that finds PO-00091 in the body of a supplier's reply also finds the
 * purchase order whose subject never mentioned it.
 *
 * The reference has to be there WHOLE: ILIKE narrows the field cheaply, and a
 * case-blind regular expression then insists on something that is not a
 * letter or a digit either side, so PO-00091 never matches inside PO-000912.
 *
 * `company` keeps it to conversations somebody from the same place is on: a
 * message from or to the sender's domain, or to the sender's own address where
 * the domain is one everybody shares (gmail and friends). Without it, two
 * suppliers who both number their orders SO-##### would have their mail
 * merged together.
 */
export async function findMergeTarget(input: {
  threadId: string
  threadCreatedAt: Date
  references: string[]
  withinDays: number
  company: { domain: string } | { address: string } | null
  /** Search the candidate's message text as well as its subjects. */
  inBodies: boolean
}): Promise<MergeTarget | null> {
  if (input.references.length === 0) return null
  const likes = input.references.map((ref) => `%${likeEscape(ref)}%`)
  const wholes = input.references.map((ref) => `(^|[^A-Za-z0-9])${regexEscape(ref)}($|[^A-Za-z0-9])`)

  const companyClause = input.company === null
    ? Prisma.sql`TRUE`
    : 'domain' in input.company
      ? Prisma.sql`EXISTS (
          SELECT 1 FROM "uin_messages" cm
           WHERE cm."thread_id" = t."id"
             AND (
               lower(cm."from_address") LIKE ${`%@${likeEscape(input.company.domain)}`}
               OR EXISTS (
                 SELECT 1 FROM unnest(cm."to_addresses" || cm."cc_addresses") AS a(addr)
                  WHERE lower(a.addr) LIKE ${`%@${likeEscape(input.company.domain)}`}
                     OR lower(a.addr) LIKE ${`%@${likeEscape(input.company.domain)}>`}
               )
             )
        )`
      : Prisma.sql`EXISTS (
          SELECT 1 FROM "uin_messages" cm
           WHERE cm."thread_id" = t."id"
             AND (
               lower(cm."from_address") = ${input.company.address}
               OR EXISTS (
                 SELECT 1 FROM unnest(cm."to_addresses" || cm."cc_addresses") AS a(addr)
                  WHERE lower(a.addr) = ${input.company.address}
                     OR lower(a.addr) LIKE ${`%<${likeEscape(input.company.address)}>`}
               )
             )
        )`

  const bodyClause = input.inBodies
    ? Prisma.sql`OR (rm."body_text" ILIKE ANY(${likes}::text[]) AND rm."body_text" ~* ANY(${wholes}::text[]))`
    : Prisma.empty

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT t."id", t."subject", t."created_at"
      FROM "uin_threads" t
     WHERE t."id" <> ${input.threadId}
       AND t."merged_into_id" IS NULL
       AND t."blocked_at" IS NULL
       AND t."channel" <> 'discussion'
       AND t."created_at" < ${input.threadCreatedAt}
       AND COALESCE(t."last_message_at", t."created_at") >= now() - (${input.withinDays} * interval '1 day')
       AND (
         (t."subject" ILIKE ANY(${likes}::text[]) AND t."subject" ~* ANY(${wholes}::text[]))
         OR EXISTS (
           SELECT 1 FROM "uin_messages" rm
            WHERE rm."thread_id" = t."id"
              AND (
                (rm."subject" ILIKE ANY(${likes}::text[]) AND rm."subject" ~* ANY(${wholes}::text[]))
                ${bodyClause}
              )
         )
       )
       AND ${companyClause}
     ORDER BY t."created_at" ASC, t."id" ASC
     LIMIT 1
  `
  const r = rows[0]
  if (!r) return null
  return { id: r.id as string, subject: (r.subject as string | null) ?? null, createdAt: r.created_at as Date }
}

export async function threadBasics(threadId: string): Promise<{
  id: string
  subject: string | null
  createdAt: Date
  inboxId: string | null
  status: string
  assigneeUserId: string | null
  unread: boolean
} | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "id", "subject", "created_at", "inbox_id", "status", "assignee_user_id", "unread"
      FROM "uin_threads" WHERE "id" = ${threadId}
  `
  const r = rows[0]
  if (!r) return null
  return {
    id: r.id as string,
    subject: (r.subject as string | null) ?? null,
    createdAt: r.created_at as Date,
    inboxId: (r.inbox_id as string | null) ?? null,
    status: r.status as string,
    assigneeUserId: (r.assignee_user_id as string | null) ?? null,
    unread: !!r.unread,
  }
}

/** Whether a colleague's account is still there to be given work. */
export async function staffUserExists(userId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`SELECT "id" FROM "User" WHERE "id" = ${userId}`
  return rows.length > 0
}

// ---------------------------------------------------------------------------
// The log.
// ---------------------------------------------------------------------------

/**
 * Claim a rule's one go at a message. True when this caller has it; false when
 * the rule has already run on it - an earlier tick, the copy of the same email
 * in another folder, or "run on recent mail" getting there first.
 */
export async function claimRuleRun(ruleId: string, messageId: string, threadId: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "uin_rule_runs" ("rule_id", "message_id", "thread_id")
    VALUES (${ruleId}, ${messageId}, ${threadId})
    ON CONFLICT ("rule_id", "message_id") DO NOTHING
    RETURNING "id"
  `
  return rows[0]?.id ?? null
}

/**
 * The other copies of one email sent between two of the site's own addresses.
 *
 * The collecting pass files that mail once per inbox (lib/sync.ts, "Mail
 * between two of our own addresses"): the receiving inbox gets it inbound, the
 * sending inbox gets it outbound, on conversations of their own, tied together
 * only by `internal_key`. Rules read the inbound side, so a rule that marks the
 * login code to sarah@ done would otherwise leave the sending side's copy - the
 * one the "All" list shows from hi@ - open for ever.
 *
 * Same account, a different conversation, never one merged away. Empty for
 * everything that is not internal mail, which is nearly everything.
 */
export async function internalCopies(messageId: string): Promise<{ messageId: string; threadId: string }[]> {
  const rows = await prisma.$queryRaw<{ id: string; thread_id: string }[]>`
    SELECT o."id", o."thread_id"
      FROM "uin_messages" m
      JOIN "uin_messages" o
        ON o."internal_key" = m."internal_key"
       AND o."connection_id" IS NOT DISTINCT FROM m."connection_id"
       AND o."id" <> m."id"
       AND o."thread_id" <> m."thread_id"
      JOIN "uin_threads" t ON t."id" = o."thread_id"
     WHERE m."id" = ${messageId}
       AND m."internal_key" IS NOT NULL
       AND o."direction" <> 'note'
       AND t."merged_into_id" IS NULL
     ORDER BY o."created_at" ASC, o."id" ASC
  `
  return rows.map((r) => ({ messageId: r.id, threadId: r.thread_id }))
}

/** The claim, finished: what the rule did, and the rule's tally moved on. */
export async function finishRuleRun(input: {
  runId: string
  ruleId: string
  threadId: string
  summary: string
  detail: Record<string, unknown>
}): Promise<void> {
  await prisma.$transaction([
    prisma.$executeRaw`
      UPDATE "uin_rule_runs"
         SET "summary" = ${input.summary}, "detail" = ${JSON.stringify(input.detail)}::jsonb,
             "thread_id" = ${input.threadId}
       WHERE "id" = ${input.runId}
    `,
    prisma.$executeRaw`
      UPDATE "uin_rules"
         SET "fire_count" = "fire_count" + 1, "last_fired_at" = CURRENT_TIMESTAMP
       WHERE "id" = ${input.ruleId}
    `,
  ])
}

/** The claim, given back: the rule matched but had nothing to do (no earlier
 *  conversation to merge with yet), so it is free to try again later. */
export async function releaseRuleRun(runId: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "uin_rule_runs" WHERE "id" = ${runId}`
}

export type RuleRunRow = {
  id: string
  messageId: string
  threadId: string | null
  summary: string | null
  mergeIds: string[]
  /** Somebody has put the merge back since. The rule will not merge that
   *  message again - its one go is spent - so a put-back merge stays put back. */
  undone: boolean
  createdAt: Date
}

/** The newest things a rule has done, for its activity list. */
export async function listRuleRuns(ruleId: string, limit = 20): Promise<RuleRunRow[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT r."id", r."message_id", r."thread_id", r."summary", r."detail", r."created_at",
           EXISTS (
             SELECT 1 FROM "uin_thread_merges" tm
              WHERE tm."undone_at" IS NOT NULL
                AND tm."id" IN (SELECT jsonb_array_elements_text(
                  CASE WHEN jsonb_typeof(r."detail"->'mergeIds') = 'array' THEN r."detail"->'mergeIds' ELSE '[]'::jsonb END
                ))
           ) AS undone
      FROM "uin_rule_runs" r
     WHERE r."rule_id" = ${ruleId} AND r."summary" IS NOT NULL
     ORDER BY r."created_at" DESC, r."id" DESC
     LIMIT ${limit}
  `
  return rows.map((r) => {
    const detail = (r.detail as Record<string, unknown> | null) ?? {}
    const mergeIds = Array.isArray(detail.mergeIds)
      ? detail.mergeIds.filter((v): v is string => typeof v === 'string')
      : []
    return {
      id: r.id as string,
      messageId: r.message_id as string,
      threadId: (r.thread_id as string | null) ?? null,
      summary: (r.summary as string | null) ?? null,
      mergeIds,
      undone: !!r.undone,
      createdAt: r.created_at as Date,
    }
  })
}
