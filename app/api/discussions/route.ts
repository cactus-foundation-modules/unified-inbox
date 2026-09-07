import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { canViewInbox } from '@/modules/unified-inbox/lib/access'
import {
  createDiscussionThread,
  fileThreadInInboxes,
  insertNote,
  ownInboxIdsForUsers,
  recordEvent,
} from '@/modules/unified-inbox/lib/db'
import { notifyMentions } from '@/modules/unified-inbox/lib/mentions'
import { noteHtml } from '@/modules/unified-inbox/lib/notes'
import { normaliseSubject } from '@/modules/unified-inbox/lib/threading'
import { DiscussionBody } from '@/modules/unified-inbox/lib/validation'

// Starting a discussion: a conversation between colleagues that no customer
// ever sees.
//
// It is made of the same internal notes the hub has always had, which is the
// point - nothing sends, nothing can be talked into sending, and there is no
// address on it to send to. What it adds is somewhere to put the FIRST one: a
// remark about the Henderson order was previously only possible if the
// Hendersons had written in.
//
// VIEW, NOT REPLY. Writing a note has always taken `unifiedinbox.view` and a
// place on the inbox's guest list, because a note leaves the building through
// no door at all. Starting one is the same act with nothing above it, so it
// asks the same question - and it asks it of every address named, one at a
// time, rather than of the first and hopefully the rest.
//
// ONE DISCUSSION PER ADDRESS NAMED. A conversation is read by whoever may read
// the inbox it sits in (D16); one thread in two inboxes would be one
// conversation with two guest lists, two unread counts and no honest answer
// about who can see it. So naming three addresses starts three discussions,
// exactly as an email to three of the site's own addresses already becomes
// three conversations (migrations/020_internal_threads.sql).
//
// AND IT LANDS IN THE POST OF WHOEVER IT IS PUT TO. That is the one thing above
// that a discussion genuinely does not want: three copies of a conversation
// between three people is three conversations that answer each other into
// nothing. So the colleagues on the To line do not each get their own - they
// get THIS one, filed under their own address as well as the starter's, which
// is the same table and the same rule a conversation belonging to two addresses
// has used since merging arrived (migrations/031_thread_merges.sql).
//
// The addresses are worked out HERE, from the names. A request that could name
// the address would be a request that could file a note in anybody's private
// post; a request that names a colleague can only ever reach the address that
// colleague already owns. Somebody with no address of their own is filed
// nowhere and reaches it through the ask on their own list, exactly as before.

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.view')) return errorResponse('Forbidden', 403)

  const parsed = DiscussionBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return errorResponse(parsed.error.issues[0]?.message ?? 'That discussion could not be read.', 400)
  }
  const { subject, body, mentions = [] } = parsed.data

  // Whoever it is put to is also asked to look at it: being on the To line of a
  // discussion IS being asked about it, and a second list saying the same thing
  // would be two ways to tell one person one thing. Their own name off it -
  // `whoToTell` drops it anyway - because putting a discussion to yourself is
  // not asking yourself a question.
  const toUserIds = [...new Set(parsed.data.toUserIds ?? [])].filter((id) => id !== user.id)
  const toTell = [...new Set([...toUserIds, ...mentions])]

  // Their own addresses, so it lands in the post they actually read rather than
  // only in the starter's. Asked once for the whole discussion, not once per
  // address it is started in.
  const toInboxIds = await ownInboxIdsForUsers(toUserIds)

  // The same address twice is one discussion, not two.
  const inboxIds = [...new Set(parsed.data.inboxIds)]

  // Checked before anything is written, so a request naming one address this
  // person may use and one they may not starts nothing at all. Half a
  // discussion is worse than none: the half that landed cannot be recalled.
  for (const inboxId of inboxIds) {
    if (!await canViewInbox(user, inboxId)) {
      return errorResponse('You do not have permission to use one of those addresses.', 403)
    }
  }

  const html = noteHtml(body)
  const preview = body.replace(/\s+/g, ' ').trim().slice(0, 200)
  const threadIds: string[] = []

  for (const inboxId of inboxIds) {
    const threadId = await createDiscussionThread({
      inboxId,
      subject,
      subjectNormalised: normaliseSubject(subject),
      preview: preview || null,
      startedByUserId: user.id,
      toUserIds,
    })
    // The address it was started in has to be on the list too: once a
    // conversation belongs to several addresses that list is read INSTEAD of
    // its own inbox, so leaving it off would file the discussion out of the
    // address it was started in.
    await fileThreadInInboxes(threadId, [inboxId, ...toInboxIds])
    const messageId = await insertNote({
      threadId,
      channel: 'discussion',
      bodyHtml: html,
      bodyText: body,
      authorUserId: user.id,
    })
    await recordEvent(threadId, user.id, 'note', { messageId })
    await notifyMentions({
      threadId,
      thread: { id: threadId, inboxId, providerModule: null },
      mentions: toTell,
      byUserId: user.id,
      messageId,
      note: body,
    })
    threadIds.push(threadId)
  }

  // The first one is where the browser is sent. On the ordinary single-address
  // discussion that is simply "the one you started".
  return NextResponse.json({ threadId: threadIds[0], threadIds })
}
