import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { canOpenThread } from '@/modules/unified-inbox/lib/access'
import {
  getThreadDetail, insertNote, recordEvent, recordLink, threadHasLink,
} from '@/modules/unified-inbox/lib/db'
import { notifyMentions } from '@/modules/unified-inbox/lib/mentions'
import { NoteBody } from '@/modules/unified-inbox/lib/validation'
import { noteHtml } from '@/modules/unified-inbox/lib/notes'
import { resolveProducts } from '@/modules/unified-inbox/lib/products'
import { renderProductTable, renderProductText } from '@/modules/unified-inbox/lib/products/render'
import { refKey, replaceSlots } from '@/modules/unified-inbox/lib/products/slots'
import type { ProductRef } from '@/modules/unified-inbox/lib/products/types'

// An internal note on a conversation: something colleagues can see and the
// customer never will. It is stored as a message with direction 'note', which
// is why nothing anywhere sends one.
//
// A note deliberately does not bump the conversation up the list or mark it
// unread (see insertNote): us talking among ourselves should not look like the
// customer writing again.
//
// Tagging a colleague puts the conversation on their own list, with its own
// snooze and its own done, and lets them into this one conversation whether or
// not the inbox it sits in was ever shared with them - see lib/mentions.ts,
// which the discussion route shares.
//
// A note may quote the catalogue, and on a discussion it is the ONLY way to:
// a discussion has nobody outside it to answer, so the note box is the whole of
// its composer. What is picked is read here rather than taken from the request -
// same rule as the send path - and what it ends up quoting is attached to the
// conversation afterwards, so a chair somebody put in front of a colleague is on
// the conversation's context line exactly as it is when the same chair goes out
// in an email.

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.view')) return errorResponse('Forbidden', 403)

  const { id } = await params
  const thread = await getThreadDetail(id)
  if (!thread) return errorResponse('That conversation no longer exists.', 404)

  if (!await canOpenThread(user, thread)) return errorResponse('Forbidden', 403)

  const parsed = NoteBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That note does not look right.', 400)
  const { text, mentions = [], products = [] } = parsed.data

  // What the shop says this minute, not what the browser claimed when the
  // picker was open. One read answers both halves: what the note prints, and
  // what ends up attached to the conversation.
  const quoted = await resolveProducts(products)
  const byKey = new Map(quoted.map((one) => [refKey(one.choice), one.choice]))
  const chosen = (ref: ProductRef) => byKey.get(refKey(ref)) ?? null

  // The words half, which is what the list, the search, the snippet AND the note
  // on the screen all read - a note is drawn from its text rather than from its
  // markup, deliberately (see ThreadPane). So each slot becomes the product
  // written out rather than the markup that was standing in for it, and a
  // product that has gone since it was picked becomes nothing.
  const words = replaceSlots(text, (ref) => {
    const choice = chosen(ref)
    return choice ? `\n${renderProductText([choice])}\n` : ''
  })

  const messageId = await insertNote({
    threadId: id,
    channel: thread.channel,
    bodyHtml: noteHtml(text, (ref) => {
      const choice = chosen(ref)
      return choice ? renderProductTable([choice]) : null
    }),
    bodyText: words,
    authorUserId: user.id,
  })
  await recordEvent(id, user.id, 'note', { messageId })

  // Everything quoted, now on the conversation - the same row an order or a
  // purchase order sits on. Checked first rather than left to the insert: two
  // notes about the same chair are one chair on the conversation, not two rows
  // of the same name.
  for (const { link } of quoted) {
    if (await threadHasLink(id, link.moduleName, link.recordType, link.recordId)) continue
    await recordLink({
      threadId: id,
      personId: null,
      moduleName: link.moduleName,
      recordType: link.recordType,
      recordId: link.recordId,
      label: link.label,
      confidence: 100,
      linkedBy: 'user',
    })
  }

  // The words, not the markup: a colleague told about this reads the note in a
  // bell notice and in an email, and neither is the place for a product slot.
  await notifyMentions({ threadId: id, thread, mentions, byUserId: user.id, messageId, note: words })

  return NextResponse.json({ ok: true, messageId })
}
