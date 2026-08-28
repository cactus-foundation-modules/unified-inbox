import { headers } from 'next/headers'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { prisma } from '@/lib/db/prisma'
import { canReplyToInbox, canViewInbox, visibleInboxIds } from '@/modules/unified-inbox/lib/access'
import {
  attachmentsForThread,
  countThreads,
  getThreadDetail,
  listConnections,
  listInboxes,
  listThreadEvents,
  listThreadMessages,
  listThreads,
  setThreadRead,
  unreadCounts,
  wakeDueThreads,
  type AttachmentRow,
} from '@/modules/unified-inbox/lib/db'
import { replyRecipients } from '@/modules/unified-inbox/lib/compose'
import { parseInboxParams, PER_PAGE } from '@/modules/unified-inbox/lib/list'
import { InboxStyles } from './inbox/styles'
import { InboxRail } from './inbox/InboxRail'
import { Filters } from './inbox/Filters'
import { ThreadListView } from './inbox/ThreadListView'
import { ThreadPane, type ThreadMessageView } from './inbox/ThreadPane'

// The hub's tab on core's Inbox page: the rail of addresses, the list of
// conversations, and whichever one is open.
//
// Every piece of state on this screen is in the URL. The core Inbox host
// renders only the tab the address asks for and hands the query string straight
// through, so a filter or a page held in the browser would describe a screen the
// server had not drawn - and a colleague could not be sent a link to what
// somebody is looking at.
//
// The access rule runs through all of it: the inboxes this person may read are
// resolved once and passed INTO the queries, never used to drop rows afterwards
// (E17). A conversation from accounts@ is not merely hidden from somebody who
// may not read it - it is never fetched, never counted and never paged.

export async function UnifiedInboxPanel({
  searchParams = {},
}: {
  searchParams?: Record<string, string>
}) {
  const user = await getSessionFromCookie()
  if (!user) return null
  if (!await hasPermission(user, 'unifiedinbox.view')) {
    return <div className="alert alert-danger">You do not have permission to read the inbox.</div>
  }

  const adminPath = (await headers()).get('x-cactus-admin-path') ?? ''
  const base = `/${adminPath}/inbox`
  const canManage = await hasPermission(user, 'unifiedinbox.manage')

  // Anything whose snooze has elapsed is open again by the time the list is
  // drawn. Doing it here rather than on a tick means a conversation is back the
  // moment somebody looks, which is the only moment it matters.
  await wakeDueThreads()

  const allInboxes = await listInboxes()
  const visibleIds = await visibleInboxIds(user, allInboxes.map((i) => i.id))
  const visible = new Set(visibleIds)
  const inboxes = allInboxes.filter((i) => visible.has(i.id))

  if (inboxes.length === 0) {
    return (
      <div className="alert alert-info">
        {canManage ? (
          <>
            No inboxes yet. Add the addresses your customers and suppliers write to in{' '}
            <a href={`/${adminPath}/config?tab=unified-inbox`}>Settings &rsaquo; Unified Inbox</a>.
          </>
        ) : (
          <>No inboxes have been shared with you yet. Whoever looks after the site can put you on one.</>
        )}
      </div>
    )
  }

  const params = parseInboxParams(searchParams)
  // The tab has to survive every link on this screen, or following one lands on
  // whichever tab the host happens to render first.
  const carried: Record<string, string> = { tab: 'unified-inbox' }
  for (const key of ['inbox', 'status', 'unread', 'assignee', 'q', 'page', 'id'] as const) {
    const value = searchParams[key]
    if (value) carried[key] = value
  }

  const staffRows = await prisma.user.findMany({
    where: { suspendedAt: null },
    select: { id: true, displayName: true, username: true },
    orderBy: { username: 'asc' },
  })
  const staff = staffRows.map((s) => ({ id: s.id, name: s.displayName || s.username }))
  const staffById = Object.fromEntries(staff.map((s) => [s.id, s.name]))

  const counts = await unreadCounts(visibleIds, canManage)

  const filters = {
    inboxIds: visibleIds,
    includeUnrouted: canManage,
    inboxId: params.inboxId,
    unroutedOnly: params.unroutedOnly,
    status: params.status,
    unreadOnly: params.unreadOnly,
    assignee: params.assignee,
    search: params.search,
    page: params.page,
    perPage: PER_PAGE,
  }

  const [rows, total, connections] = await Promise.all([
    listThreads(filters),
    countThreads(filters),
    listConnections(),
  ])
  const neverSynced = connections.length === 0 || connections.every((c) => !c.lastSyncAt)

  // ---- the conversation on the right, if the address asks for one ---------
  let threadPane: React.ReactNode = null
  if (params.threadId) {
    const thread = await getThreadDetail(params.threadId)
    const allowed = thread
      ? thread.inboxId ? await canViewInbox(user, thread.inboxId) : canManage
      : false
    if (!thread || !allowed) {
      threadPane = (
        <div className="uin-empty">
          <strong>That conversation is not here</strong>
          It may have been removed, or it may be in an inbox that has not been shared with you.
        </div>
      )
    } else {
      // Opening a conversation is what marks it read, which is what everybody
      // means by opening one.
      if (thread.unread) await setThreadRead(thread.id, false)

      const [messages, files, events] = await Promise.all([
        listThreadMessages(thread.id),
        attachmentsForThread(thread.id),
        listThreadEvents(thread.id),
      ])
      const byMessage = new Map<string, AttachmentRow[]>()
      for (const file of files) {
        const list = byMessage.get(file.messageId)
        if (list) list.push(file)
        else byMessage.set(file.messageId, [file])
      }
      const view: ThreadMessageView[] = messages.map((m) => ({
        ...m,
        attachments: byMessage.get(m.id) ?? [],
      }))

      const newest = [...messages].reverse().find((m) => m.direction !== 'note') ?? null
      const ownAddresses = allInboxes.map((i) => i.address)
      const reply = newest
        ? replyRecipients(
            {
              fromAddress: newest.fromAddress,
              // The sync engine records Reply-To when the sender set one, and it
              // beats From - which is the entire purpose of the header (E13).
              replyTo: newest.replyTo,
              toAddresses: newest.toAddresses,
              ccAddresses: newest.ccAddresses,
            },
            'reply',
            ownAddresses,
          )
        : { to: [], cc: [] }
      const replyAll = newest
        ? replyRecipients(
            {
              fromAddress: newest.fromAddress,
              replyTo: newest.replyTo,
              toAddresses: newest.toAddresses,
              ccAddresses: newest.ccAddresses,
            },
            'reply-all',
            ownAddresses,
          )
        : { to: [], cc: [] }

      const canReply = thread.inboxId ? await canReplyToInbox(user, thread.inboxId) : false
      const cannotReplyReason = canReply
        ? null
        : thread.inboxId
          ? 'You can read this inbox but not send from it. Leave a note instead, or ask whoever looks after the site.'
          : 'This conversation is not filed in one of your addresses, so there is nothing to send it from.'

      threadPane = (
        <ThreadPane
          base={base}
          params={carried}
          thread={thread}
          inboxName={allInboxes.find((i) => i.id === thread.inboxId)?.name ?? null}
          messages={view}
          events={events}
          staff={staff}
          staffById={staffById}
          canReply={canReply}
          cannotReplyReason={cannotReplyReason}
          replyTo={[...reply.to, ...reply.cc]}
          replyAllTo={[...replyAll.to, ...replyAll.cc]}
          now={new Date()}
        />
      )
    }
  }

  return (
    <>
      <InboxStyles />
      <div className="uin" data-thread={params.threadId ? 'open' : 'closed'}>
        <InboxRail
          base={base}
          params={carried}
          inboxes={inboxes.map((i) => ({ id: i.id, name: i.name, address: i.address }))}
          counts={counts}
          currentInboxId={params.unroutedOnly ? 'none' : params.inboxId}
          showUnrouted={canManage}
        />

        <div className="uin-listpane">
          <Filters
            base={base}
            params={carried}
            status={params.status}
            unreadOnly={params.unreadOnly}
            assignee={params.assignee}
            search={params.search}
            staff={staff}
            currentUserId={user.id}
          />
          <ThreadListView
            base={base}
            params={carried}
            rows={rows}
            total={total}
            page={params.page}
            openThreadId={params.threadId}
            staffById={staffById}
            neverSynced={neverSynced}
            searching={!!params.search}
            now={new Date()}
          />
        </div>

        {threadPane}
      </div>
    </>
  )
}
