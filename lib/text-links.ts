import { prisma } from '@/lib/db/prisma'
import { listIdentities, recomputeThreadCounters, touchThread } from './db'
import { isSideText, textableNumber, type TextLink } from './text-rules'
import { buildSnippet } from './threading'

// ---------------------------------------------------------------------------
// Texting somebody from an email conversation, and filing their reply there.
//
// The texts belong to whichever module sends them, and that module files every
// text with one number as ONE phone conversation (lib/provider-sync.ts copies
// it across as a Phone conversation). That is right for somebody who only ever
// texts. It is wrong for a customer halfway through an email about their order
// who is sent a quick "are you in on Tuesday?" - their "yes" belongs under the
// email that asked, not in a second conversation in another part of the rail
// where nobody working the email will see it.
//
// So a text sent from an email conversation leaves a note behind (the
// uin_text_links table, migration 066): texts with this number, from now on,
// belong on THAT conversation. The collecting pass reads the note and files the
// customer's reply there instead of on the phone conversation, and it lands
// exactly as an email would - the conversation wakes, comes out of the bin,
// goes unread, and anything scheduled on it stands down.
//
// THE NOTE IS PER NUMBER, and the conversation that texted them most recently
// wins. Two emails texting the same customer is two questions, and the reply
// most likely answers the latest.
//
// ONLY TEXTS ARE REDIRECTED. A call or a voicemail from the same number stays
// on the phone conversation, because the channel files all three together and
// a missed call is not somebody answering a question in writing. Which is a
// text is the channel's own answer (`medium`), never read out of its ids.
//
// "Move to the Phone channel" undoes it for one reply and ends the note, so
// the next text goes where texts always went. The note is kept, ended, rather
// than deleted: texts already filed on the email conversation must still be
// recognised as held, or the collecting pass would file them a second time on
// the phone conversation.
// ---------------------------------------------------------------------------

/** The mark on a text written here before the channel hands back its own id
 *  for it. Shaped so it can never be mistaken for one of theirs, and matched
 *  on in claimSentText below. */
export const SENT_TEXT_PREFIX = 'uin-out:text:'

/**
 * The number an email conversation's person can be texted on, or null when
 * there is not one - or when the conversation is not an email one: a phone or
 * chat conversation is already answered down its own channel.
 */
export async function threadTextNumber(
  thread: { channel: string; providerModule: string | null; personId: string | null },
  diallingCode: string,
): Promise<string | null> {
  if (thread.channel !== 'email' || thread.providerModule || !thread.personId) return null
  const identities = await listIdentities(thread.personId)
  return textableNumber(
    identities.filter((identity) => identity.kind === 'phone').map((identity) => identity.value),
    diallingCode,
  )
}

function mapLink(r: Record<string, unknown>): TextLink {
  return {
    phone: r.phone as string,
    threadId: r.thread_id as string,
    since: r.since as Date,
    endedAt: (r.ended_at as Date | null) ?? null,
    providerModule: (r.provider_module as string | null) ?? null,
    externalId: (r.external_id as string | null) ?? null,
    seenThrough: (r.seen_through as Date | null) ?? null,
  }
}

/** The notes for these numbers, for one collecting pass. Ended ones included -
 *  see the header. Follows a merge, so a reply to a conversation that has since
 *  been merged lands on what it became. */
export async function textLinksFor(phones: readonly string[]): Promise<Map<string, TextLink>> {
  const wanted = [...new Set(phones.filter(Boolean))]
  if (wanted.length === 0) return new Map()
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT l."phone", COALESCE(t."merged_into_id", l."thread_id") AS "thread_id",
           l."since", l."ended_at", l."provider_module", l."external_id", l."seen_through"
      FROM "uin_text_links" l
      JOIN "uin_threads" t ON t."id" = l."thread_id"
     WHERE l."phone" = ANY(${wanted}::text[])
  `
  return new Map(rows.map((r) => [r.phone as string, mapLink(r)]))
}

export async function textLinkFor(phone: string): Promise<TextLink | null> {
  return (await textLinksFor([phone])).get(phone) ?? null
}

/** Texts with this number now belong on this conversation. A conversation that
 *  already held the note keeps the moment it started; a different one, or one
 *  whose note had been ended, starts from now. */
export async function linkTextsToThread(input: {
  phone: string
  threadId: string
  since: Date
  userId: string
}): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "uin_text_links" ("phone", "thread_id", "since", "created_by")
    VALUES (${input.phone}, ${input.threadId}, ${input.since}, ${input.userId})
    ON CONFLICT ("phone") DO UPDATE SET
      "since" = CASE
        WHEN "uin_text_links"."thread_id" = EXCLUDED."thread_id" AND "uin_text_links"."ended_at" IS NULL
        THEN "uin_text_links"."since" ELSE EXCLUDED."since" END,
      "thread_id"  = EXCLUDED."thread_id",
      "ended_at"   = NULL,
      "created_by" = EXCLUDED."created_by",
      "updated_at" = CURRENT_TIMESTAMP
  `
}

/** Recorded after a pass has read the phone conversation for this number:
 *  which channel conversation the texts come from, and how far it was read. */
export async function markTextLinkRead(input: {
  phone: string
  providerModule: string
  externalId: string
  through: Date
}): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "uin_text_links"
       SET "provider_module" = ${input.providerModule},
           "external_id"     = ${input.externalId},
           "seen_through"    = GREATEST(COALESCE("seen_through", ${input.through}), ${input.through}),
           "updated_at"      = CURRENT_TIMESTAMP
     WHERE "phone" = ${input.phone}
  `
}

/**
 * Which of these channel messages this hub already holds, and on which
 * conversation. Asked across every conversation rather than the phone one,
 * because a redirected text lives on an email conversation the ordinary
 * per-conversation unique index knows nothing about.
 */
export async function heldChannelMessages(
  providerModule: string,
  providerMessageIds: readonly string[],
): Promise<Map<string, string>> {
  if (providerMessageIds.length === 0) return new Map()
  const rows = await prisma.$queryRaw<{ provider_message_id: string; thread_id: string }[]>`
    SELECT "provider_message_id", "thread_id"
      FROM "uin_messages"
     WHERE "source" = 'provider'
       AND "provider_module" = ${providerModule}
       AND "provider_message_id" = ANY(${[...providerMessageIds]}::text[])
  `
  return new Map(rows.map((r) => [r.provider_message_id, r.thread_id]))
}

/**
 * A text written here, as it was sent: on the email conversation it was sent
 * from, straight away, so whoever pressed Send sees it rather than waiting for
 * the channel to hand its own copy back. That copy is matched to this row by
 * claimSentText on the next collection, so it is one message and not two.
 */
export async function recordSentText(input: {
  threadId: string
  phone: string
  body: string
  authorUserId: string
  authorName: string | null
  sentAt: Date
}): Promise<string> {
  const snippet = buildSnippet(input.body)
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "uin_messages"
      ("thread_id", "direction", "channel", "from_name", "from_phone",
       "body_text", "snippet", "sent_at", "source", "provider_message_id", "author_user_id")
    VALUES (${input.threadId}, 'out', 'sms', ${input.authorName},
            -- The other party's number, which is what this column holds in
            -- both directions: the one this went to.
            ${input.phone},
            ${input.body}, ${snippet}, ${input.sentAt}, 'provider',
            ${`${SENT_TEXT_PREFIX}${input.sentAt.getTime()}:${input.authorUserId}`},
            ${input.authorUserId})
    RETURNING "id"
  `
  const id = rows[0]!.id
  await touchThread(input.threadId, {
    sentAt: input.sentAt,
    direction: 'out',
    preview: snippet || null,
    subject: null,
    subjectNormalised: '',
    markUnread: false,
    inboxId: null,
    arrivedNow: true,
  })
  return id
}

/**
 * The channel's own copy of a text written here, matched to the row we wrote
 * when it was sent - same conversation, same words, within a few minutes - and
 * given the channel's identity for it. Returns false when there was nothing of
 * ours to claim, which means the text was sent from somewhere else.
 */
export async function claimSentText(input: {
  threadId: string
  bodyText: string
  sentAt: Date
  providerModule: string
  providerMessageId: string
}): Promise<boolean> {
  const window = 15 * 60_000
  const from = new Date(input.sentAt.getTime() - window)
  const to = new Date(input.sentAt.getTime() + window)
  const updated = await prisma.$executeRaw`
    UPDATE "uin_messages"
       SET "provider_module" = ${input.providerModule},
           "provider_message_id" = ${input.providerMessageId}
     WHERE "id" = (
       SELECT "id" FROM "uin_messages"
        WHERE "thread_id" = ${input.threadId}
          AND "source" = 'provider'
          AND "direction" = 'out'
          AND "channel" = 'sms'
          AND "provider_message_id" LIKE ${SENT_TEXT_PREFIX + '%'}
          AND "body_text" = ${input.bodyText}
          AND "sent_at" BETWEEN ${from} AND ${to}
        ORDER BY "sent_at" ASC
        LIMIT 1
     )
  `
  return updated > 0
}

/** One text on an email conversation, in what moving it out needs. */
export type SideTextForMove = {
  id: string
  threadId: string
  threadChannel: string
  threadMergedIntoId: string | null
  direction: 'in' | 'out' | 'note'
  channel: string
  providerModule: string | null
  providerMessageId: string | null
  phone: string | null
}

export async function sideTextForMove(id: string): Promise<SideTextForMove | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT m."id", m."thread_id", m."direction", m."channel", m."provider_module",
           m."provider_message_id", m."from_phone",
           t."channel" AS "thread_channel", t."merged_into_id"
      FROM "uin_messages" m
      JOIN "uin_threads" t ON t."id" = m."thread_id"
     WHERE m."id" = ${id}
  `
  const r = rows[0]
  if (!r) return null
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    threadChannel: r.thread_channel as string,
    threadMergedIntoId: (r.merged_into_id as string | null) ?? null,
    direction: r.direction as 'in' | 'out' | 'note',
    channel: r.channel as string,
    providerModule: (r.provider_module as string | null) ?? null,
    providerMessageId: (r.provider_message_id as string | null) ?? null,
    phone: (r.from_phone as string | null) ?? null,
  }
}

/** Why a message cannot be moved out to the Phone channel, in words, or null
 *  when it can. */
export function moveTextRefusal(message: SideTextForMove, link: TextLink | null): string | null {
  if (message.threadMergedIntoId) {
    return 'That conversation has been merged into another one. Open that one and move it from there.'
  }
  if (!isSideText(message, message.threadChannel) || message.direction !== 'in') {
    return 'Only a text somebody sent in can be moved out to the Phone channel.'
  }
  if (!message.phone || !message.providerModule || !message.providerMessageId) {
    return 'That text has not been matched to its phone conversation yet. Try again in a few minutes.'
  }
  if (!link?.providerModule || !link.externalId) {
    return 'The phone conversation this text belongs to cannot be found. Try again after the next check for new messages.'
  }
  return null
}

/**
 * Moves one text off an email conversation and onto the phone conversation
 * with that number - the one the channel would have filed it on - starting that
 * conversation when there is not one yet. The note is ended as well, so the
 * next text they send goes to the Phone channel like any other.
 *
 * The phone conversation is started with the channel's own identity on it, so
 * the next collection fills it in (its subject, and anything else said since)
 * rather than starting a second one beside it. `seen_through` is cleared for
 * the same reason: the next pass re-reads the number rather than believing it
 * has already caught up.
 */
export async function moveTextToPhone(
  message: SideTextForMove,
  link: TextLink,
  userId: string,
): Promise<{ threadId: string }> {
  const providerModule = link.providerModule!
  const externalId = link.externalId!

  return prisma.$transaction(async (tx) => {
    const existing = await tx.$queryRaw<{ id: string; merged_into_id: string | null }[]>`
      SELECT "id", "merged_into_id" FROM "uin_threads"
       WHERE "provider_module" = ${providerModule} AND "external_id" = ${externalId}
       LIMIT 1
    `
    let target = existing[0] ? (existing[0].merged_into_id ?? existing[0].id) : null
    if (!target) {
      const created = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "uin_threads"
          ("provider_module", "external_id", "channel", "subject", "subject_normalised",
           "last_message_at", "last_direction", "unread", "message_count")
        SELECT ${providerModule}, ${externalId}, 'sms', NULL, '',
               m."sent_at", 'in', true, 0
          FROM "uin_messages" m WHERE m."id" = ${message.id}
        RETURNING "id"
      `
      target = created[0]!.id
    }

    // Already on the phone conversation as well - a pass that ran before the
    // note existed filed it there - so the copy here is the one to go.
    const clash = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "uin_messages"
       WHERE "thread_id" = ${target} AND "source" = 'provider'
         AND "provider_message_id" = ${message.providerMessageId}
       LIMIT 1
    `
    if (clash[0]) {
      await tx.$executeRaw`DELETE FROM "uin_messages" WHERE "id" = ${message.id}`
    } else {
      await tx.$executeRaw`
        UPDATE "uin_messages" SET "thread_id" = ${target} WHERE "id" = ${message.id}
      `
    }

    await recomputeThreadCounters(tx, message.threadId)
    await recomputeThreadCounters(tx, target)
    await tx.$executeRaw`
      UPDATE "uin_threads" SET "unread" = true, "status" = 'open', "snooze_until" = NULL
       WHERE "id" = ${target} AND "last_direction" = 'in'
    `

    await tx.$executeRaw`
      UPDATE "uin_text_links"
         SET "ended_at" = CURRENT_TIMESTAMP, "seen_through" = NULL, "updated_at" = CURRENT_TIMESTAMP
       WHERE "phone" = ${link.phone}
    `

    await tx.$executeRaw`
      INSERT INTO "uin_events" ("thread_id", "user_id", "kind", "detail")
      VALUES (${message.threadId}, ${userId}, 'text_moved_out',
              ${JSON.stringify({ threadId: target })}::jsonb)
    `
    await tx.$executeRaw`
      INSERT INTO "uin_events" ("thread_id", "user_id", "kind", "detail")
      VALUES (${target}, ${userId}, 'text_moved_in',
              ${JSON.stringify({ threadId: message.threadId })}::jsonb)
    `
    return { threadId: target }
  }, { timeout: 30_000, maxWait: 15_000 })
}
