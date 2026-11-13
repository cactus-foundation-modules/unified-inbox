import { prisma } from '@/lib/db/prisma'
import type { SessionUser } from '@/lib/auth/session'
import { canOpenThread, visibleInboxIds } from '@/modules/unified-inbox/lib/access'

// The email conversations with one site member, for the admin member page
// (core's members.admin-member-detail extension point).
//
// "With them" means either of two things, because neither alone is complete:
//   - the conversation's person has the member's address among their email
//     identities - the normal case, and the one that survives a person having
//     several addresses;
//   - the conversation's contact address IS the member's address - for a
//     thread whose people pass never ran and was left with no person at all.
// Matched case-insensitively on both sides, as everywhere else an address is
// compared.
//
// Conversations folded into another by a merge are left out: the one they were
// merged into is listed, and opening the loser only redirects to it anyway.
//
// Nobody is shown a conversation they could not open in the inbox itself. The
// candidates are read first, then each is put to the same guest-list question
// the inbox asks (lib/access.ts) - by address in one go for the usual case, by
// the full rule only for the odd one that address alone refuses.

export type MemberThread = {
  id: string
  inboxId: string | null
  subject: string | null
  preview: string | null
  status: 'open' | 'snoozed' | 'done'
  unread: boolean
  messageCount: number
  lastMessageAt: Date | null
  lastDirection: 'in' | 'out' | null
  inboxName: string | null
}

type Row = {
  id: string
  inbox_id: string | null
  provider_module: string | null
  subject: string | null
  preview: string | null
  status: 'open' | 'snoozed' | 'done'
  unread: boolean
  message_count: number
  last_message_at: Date | null
  last_direction: string | null
  inbox_name: string | null
}

export const MEMBER_THREADS_LIMIT = 50

export async function listMemberThreads(user: SessionUser, email: string): Promise<{ threads: MemberThread[]; more: boolean }> {
  const address = email.trim()
  if (!address) return { threads: [], more: false }

  const rows = await prisma.$queryRaw<Row[]>`
    SELECT t."id", t."inbox_id", t."provider_module", t."subject", t."preview", t."status", t."unread",
           t."message_count", t."last_message_at", t."last_direction", ib."name" AS inbox_name
    FROM "uin_threads" t
    LEFT JOIN "uin_inboxes" ib ON ib."id" = t."inbox_id"
    WHERE t."channel" = 'email'
      AND t."merged_into_id" IS NULL
      AND (
        t."person_id" IN (
          SELECT i."person_id" FROM "uin_person_identities" i
          WHERE i."kind" = 'email' AND LOWER(i."value") = LOWER(${address})
        )
        OR LOWER(t."contact_address") = LOWER(${address})
      )
    ORDER BY t."last_message_at" DESC NULLS LAST, t."id"
    LIMIT ${MEMBER_THREADS_LIMIT + 1}
  `

  const inboxIds = [...new Set(rows.map((r) => r.inbox_id).filter((id): id is string => !!id))]
  const readable = new Set(inboxIds.length > 0 ? await visibleInboxIds(user, inboxIds) : [])

  const allowed: Row[] = []
  for (const row of rows) {
    if (row.inbox_id && readable.has(row.inbox_id)) { allowed.push(row); continue }
    if (await canOpenThread(user, { id: row.id, inboxId: row.inbox_id, providerModule: row.provider_module })) allowed.push(row)
  }

  return {
    threads: allowed.slice(0, MEMBER_THREADS_LIMIT).map((r) => ({
      id: r.id,
      inboxId: r.inbox_id,
      subject: r.subject,
      preview: r.preview,
      status: r.status,
      unread: r.unread,
      messageCount: r.message_count,
      lastMessageAt: r.last_message_at,
      lastDirection: r.last_direction === 'in' || r.last_direction === 'out' ? r.last_direction : null,
      inboxName: r.inbox_name,
    })),
    more: rows.length > MEMBER_THREADS_LIMIT,
  }
}
