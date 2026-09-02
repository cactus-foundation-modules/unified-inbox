import Link from 'next/link'
import { headers } from 'next/headers'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { prisma } from '@/lib/db/prisma'
import { canReplyToInbox, canViewInbox, replyableInboxIds, visibleInboxIds } from '@/modules/unified-inbox/lib/access'
import {
  attachmentsForThread,
  countDrafts,
  defaultInboxIdFor,
  countThreads,
  draftForThread,
  getDraft,
  getPerson,
  getSettings,
  getThreadDetail,
  linksForPerson,
  linksForThread,
  listConnections,
  listDrafts,
  listIdentities,
  listInboxes,
  listPersonEvents,
  listThreadEvents,
  listThreadMessages,
  listSentMessages,
  countSentMessages,
  listThreads,
  outboundLogForAddresses,
  peopleInOrganisation,
  setThreadRead,
  statusCounts,
  threadsForPerson,
  undoableMerges,
  unreadCounts,
  wakeDueThreads,
  type AttachmentRow,
} from '@/modules/unified-inbox/lib/db'
import { attachableKinds, loadContext } from '@/modules/unified-inbox/lib/adapters'
import { defaultLinkKind } from '@/modules/unified-inbox/lib/link-kinds'
import { modulesForInbox } from '@/modules/unified-inbox/lib/module-senders'
import { canEditDraft, forComposer } from '@/modules/unified-inbox/lib/drafts'
import { addressesForPerson, buildContextQuery } from '@/modules/unified-inbox/lib/identity'
import { ContextRail } from './inbox/ContextRail'
import { PersonView } from './inbox/PersonView'
import { replyRecipients } from '@/modules/unified-inbox/lib/compose'
import { chooseSendingInbox, effectiveInboxParam, inboxHref, parseInboxParams, PER_PAGE } from '@/modules/unified-inbox/lib/list'
import { providerForModule, visibleProviderChannels } from '@/modules/unified-inbox/lib/provider-registry'
import { InboxStyles } from './inbox/styles'
import { InboxTabs } from './inbox/InboxTabs'
import { StatusTabs } from './inbox/StatusTabs'
import { Filters } from './inbox/Filters'
import { ThreadListView } from './inbox/ThreadListView'
import { DraftListView } from './inbox/DraftListView'
import { SentListView } from './inbox/SentListView'
import { ThreadPane, type ThreadMessageView } from './inbox/ThreadPane'
import { ComposeView } from './inbox/ComposeView'
import { DraftReadOnlyView } from './inbox/DraftReadOnlyView'

// The hub's tab on core's Inbox page: the addresses along the top, where each
// conversation stands under them, the list, and whichever one is open.
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
  const canEditLinks = canManage || await hasPermission(user, 'unifiedinbox.reply')

  // Anything whose snooze has elapsed is open again by the time the list is
  // drawn. Doing it here rather than on a tick means a conversation is back the
  // moment somebody looks, which is the only moment it matters.
  await wakeDueThreads()

  const allInboxes = await listInboxes()
  const visibleIds = await visibleInboxIds(user, allInboxes.map((i) => i.id))
  const visible = new Set(visibleIds)
  const inboxes = allInboxes.filter((i) => visible.has(i.id))

  // The channels another module owns - chat, enquiries, the phone. They sit in
  // no inbox and are not governed by the inbox guest lists: the module that owns
  // each one says who may read it, and this hub honours that answer.
  const channels = await visibleProviderChannels(user)
  const channelModules = channels.map((c) => c.moduleName)

  if (inboxes.length === 0 && channels.length === 0) {
    return (
      <div className="alert alert-info">
        {canManage ? (
          <>
            No inboxes yet. Add the addresses your customers and suppliers write to in{' '}
            <Link href={`/${adminPath}/config?tab=unified-inbox`}>Settings &rsaquo; Unified Inbox</Link>.
          </>
        ) : (
          <>No inboxes have been shared with you yet. Whoever looks after the site can put you on one.</>
        )}
      </div>
    )
  }

  // The address this person calls their own, if it is still one they may read.
  // Resolved against the visible list rather than trusted: an address can be
  // taken off somebody's guest list, or deleted, long after it was made theirs,
  // and a tab that opens on "that inbox is not here" is worse than no tab.
  const ownInboxId = await defaultInboxIdFor(user.id)
  const pinnedInboxId = ownInboxId && visible.has(ownInboxId) ? ownInboxId : null

  // An address of one's own is where the hub opens when the URL names no tab,
  // so it is settled here, before anything is parsed - every query, count and
  // link below is then built from the one answer rather than from two.
  const wantedInbox = effectiveInboxParam(searchParams.inbox, pinnedInboxId)
  const chosen = wantedInbox ? { ...searchParams, inbox: wantedInbox } : searchParams
  const params = parseInboxParams(chosen)
  // The tab has to survive every link on this screen, or following one lands on
  // whichever tab the host happens to render first.
  const carried: Record<string, string> = { tab: 'unified-inbox' }
  for (const key of ['inbox', 'status', 'unread', 'assignee', 'q', 'page', 'id', 'person'] as const) {
    const value = chosen[key]
    if (value) carried[key] = value
  }

  const staffRows = await prisma.user.findMany({
    where: { suspendedAt: null },
    select: { id: true, displayName: true, username: true },
    orderBy: { username: 'asc' },
  })
  const staff = staffRows.map((s) => ({ id: s.id, name: s.displayName || s.username }))
  const staffById = Object.fromEntries(staff.map((s) => [s.id, s.name]))

  const counts = await unreadCounts(visibleIds, canManage, channelModules)
  const allUnread = Object.values(counts).reduce((a, b) => a + b, 0)

  // Writing a new one is a different grant from reading (D16), so the From menu
  // and the button that opens it are both built from the inboxes this person may
  // SEND from. No sendable address means no button: an invitation to write that
  // ends in "you do not have permission to send from that inbox" is worse than
  // no invitation.
  const sendableIds = await replyableInboxIds(user, inboxes.map((i) => i.id))
  const sendable = inboxes.filter((i) => sendableIds.includes(i.id))
  const composeHref = sendable.length > 0
    ? inboxHref(base, carried, { compose: '1', draft: null, id: null, person: null })
    : null

  // Drafts filed on an address are read by whoever can read that address, the
  // same as every other message on it, and the query says so rather than the
  // caller (see lib/db.ts). The count is what the Drafts tab shows; the list
  // itself is only fetched when that tab is the one open.
  const draftCount = await countDrafts(user.id, visibleIds)
  const drafts = params.draftsOnly ? await listDrafts(user.id, visibleIds) : []

  // Everything that has left, across every address this person may read. Only
  // fetched when that is the list being looked at.
  const [sent, sentTotal] = params.sentOnly
    ? await Promise.all([
        listSentMessages(visibleIds, canManage, channelModules, params.page, PER_PAGE),
        countSentMessages(visibleIds, canManage, channelModules),
      ])
    : [[] as Awaited<ReturnType<typeof listSentMessages>>, 0]

  const filters = {
    inboxIds: visibleIds,
    includeUnrouted: canManage,
    providerModules: channelModules,
    inboxId: params.inboxId,
    providerModule: params.providerModule,
    unroutedOnly: params.unroutedOnly,
    status: params.status,
    unreadOnly: params.unreadOnly,
    assignee: params.assignee,
    search: params.search,
    page: params.page,
    perPage: PER_PAGE,
  }

  // Drafts take the list pane's place, so the conversation queries are not run
  // at all rather than run and thrown away.
  const connections = await listConnections()
  // The module's own settings, fetched once for the whole screen: the tab row
  // needs them to know whether to keep checking for mail while somebody is
  // watching, and the conversation pane needs them for which end it opens at.
  const settings = await getSettings()
  // The status tabs count what is behind them given everything else already
  // chosen, so they come from the same filters with the status left out.
  const listing = params.draftsOnly || params.sentOnly
  const [rows, total, statuses] = listing
    ? [[] as Awaited<ReturnType<typeof listThreads>>, 0, {} as Record<string, number>]
    : await Promise.all([listThreads(filters), countThreads(filters), statusCounts(filters)])
  // "Nothing has been collected yet" is a story about collecting mail, so it is
  // only told where collecting mail is what fills the list. A site whose
  // channels are a live chat and an enquiry form has no mail connection to have
  // run, and was being told its inbox had never collected anything - which is
  // true, and beside the point, and points at a screen most readers cannot open.
  const neverSynced = !params.providerModule
    && inboxes.length > 0
    && (connections.length === 0 || connections.every((c) => !c.lastSyncAt))

  // ---- one person's own page, if the address asks for one ----------------
  //
  // It takes the same place on the screen as a conversation, because it answers
  // the same question about the same human from a different angle: what have we
  // said to each other, and what does the rest of the site know about them.
  let personPane: React.ReactNode = null
  if (params.personId && !params.composing) {
    const person = await getPerson(params.personId)
    if (!person) {
      personPane = personNotHere()
    } else {
      const personThreads = await threadsForPerson(person.id, visibleIds, canManage, channelModules)
      if (personThreads.length === 0 && !canManage) {
        // A person's page is reachable by anybody who may read the inbox, so it
        // needs the same gate the conversations themselves have. Otherwise
        // somebody who can only open hi@ learns the name, the addresses and the
        // subject lines of a supplier who has only ever written to accounts@ -
        // which is the breach in E17 wearing a different hat.
        personPane = personNotHere()
      } else {
      const query = await buildContextQuery(person.id)
      const [identities, sections, links, events, merges, alsoHere, addresses] =
        await Promise.all([
          listIdentities(person.id),
          query ? loadContext(user, query) : Promise.resolve([]),
          linksForPerson(person.id),
          listPersonEvents(person.id),
          canManage ? undoableMerges(person.id) : Promise.resolve([]),
          person.organisationId
            ? peopleInOrganisation(person.organisationId, person.id)
            : Promise.resolve([]),
          addressesForPerson(person.id),
        ])
      // Automated mail the site sent them: order confirmations, purchase order
      // emails and the like. Brevo sends those and they never touch anybody's
      // Sent folder, so core's ledger is the only record there is (D13).
      const outbound = await outboundLogForAddresses(addresses)

      personPane = (
        <PersonView
          adminPath={adminPath}
          base={base}
          params={carried}
          person={person}
          identities={identities}
          threads={personThreads}
          outbound={outbound}
          sections={sections}
          links={links}
          events={events}
          merges={merges}
          alsoHere={alsoHere}
          staffById={staffById}
          canEdit={canEditLinks}
          canManage={canManage}
          now={new Date()}
        />
      )
      }
    }
  }

  // ---- the conversation on the right, if the address asks for one ---------
  let threadPane: React.ReactNode = null
  let contextRail: React.ReactNode = null
  if (!params.composing && !params.personId && params.threadId) {
    const thread = await getThreadDetail(params.threadId)
    const allowed = thread
      ? thread.providerModule
        // A conversation from another channel answers to that module's own
        // permission, not to the inbox guest lists - it never had an address.
        ? channelModules.includes(thread.providerModule)
        : thread.inboxId
          ? await canViewInbox(user, thread.inboxId)
          : canManage
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

      const [messages, files, events, ownDraft] = await Promise.all([
        listThreadMessages(thread.id),
        attachmentsForThread(thread.id),
        listThreadEvents(thread.id),
        draftForThread(thread.id, user.id, sendableIds),
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

      const channel = thread.providerModule
        ? channels.find((c) => c.moduleName === thread.providerModule) ?? null
        : null
      const canReply = thread.providerModule
        ? (channel?.canReply ?? false) && await hasPermission(user, 'unifiedinbox.reply')
        : thread.inboxId
          ? await canReplyToInbox(user, thread.inboxId)
          : false
      // Deleting takes the same two halves as replying: the channel has to offer
      // it, and this reader has to be allowed on that channel. Note it is the
      // channel's OWN permission that was already checked to build `channels`,
      // so a channel this person cannot see never gets this far.
      const canDeleteMessages = thread.providerModule ? (channel?.canDelete ?? false) : false

      // Blocking asks the channel who it is dealing with, which is a round trip,
      // so it is only asked where the channel can actually refuse somebody and
      // this reader may act on it.
      let blockState: { blocked: boolean; channelLabel: string } | null = null
      if (thread.providerModule && channel?.canBlock && (await hasPermission(user, 'unifiedinbox.reply'))) {
        const resolved = await providerForModule(thread.providerModule)
        const ask = resolved?.provider.isParticipantBlocked
        if (ask && thread.externalId) {
          try {
            blockState = { blocked: await ask(thread.externalId), channelLabel: channel.label }
          } catch {
            // A channel that cannot say is not a reason to take the conversation
            // off somebody. Offer the block and let the press be the answer.
            blockState = { blocked: false, channelLabel: channel.label }
          }
        }
      }

      const cannotReplyReason = canReply
        ? null
        : thread.providerModule
          ? channel
            ? `${channel.label} conversations are read here and answered where they came from.`
            : 'The part of the site that handles this channel is no longer installed, so this cannot be answered here.'
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
          draft={ownDraft ? forComposer(ownDraft) : null}
          newestFirst={settings.newestFirst}
          canDeleteMessages={canDeleteMessages}
          blockState={blockState}
          now={new Date()}
        />
      )

      // What the rest of the site knows about whoever this is. Every block in
      // it reads another module and writes to none of them, and a module that
      // is not installed costs one cheap check and contributes nothing.
      const person = thread.personId ? await getPerson(thread.personId) : null
      const query = person ? await buildContextQuery(person.id) : null
      //
      // What may be attached by hand is a separate question from what is here
      // already: the kinds are whichever record-keeping modules this viewer may
      // see, and which one the picker opens on comes from what the inbox is
      // used for. An address purchasing sends from is an address suppliers
      // answer purchase orders at, and that is worth one less choice made by
      // hand on every conversation in it.
      const [sections, links, kindOptions, senderModules] = await Promise.all([
        query ? loadContext(user, query) : Promise.resolve([]),
        linksForThread(thread.id),
        canEditLinks ? attachableKinds(user) : Promise.resolve([]),
        canEditLinks && thread.inboxId ? modulesForInbox(thread.inboxId) : Promise.resolve([]),
      ])

      contextRail = (
        <ContextRail
          adminPath={adminPath}
          threadId={thread.id}
          base={base}
          params={carried}
          person={person}
          noPersonReason={person ? null : reasonThereIsNobody(thread.channel)}
          sections={sections}
          links={links}
          canEditLinks={canEditLinks}
          linkKinds={kindOptions}
          defaultLinkKind={defaultLinkKind(kindOptions, senderModules)}
        />
      )
    }
  }

  // ---- writing a brand new one, if the address asks for it ---------------
  let composePane: React.ReactNode = null
  // Said in the reading pane rather than in a dialog of its own. It was a box
  // dressed as a dialog with no Escape, no focus moved into it and nothing
  // labelling it, which is a dialog in looks only - and there is nothing here to
  // answer, only something to be told.
  let cannotComposePane: React.ReactNode = null
  if (params.composing) {
    // Only ever one this person may READ, and the query is what decides it
    // rather than a check afterwards, so a guessed id in the address finds
    // nothing. Whether they may also change it is the next question down.
    const editing = params.draftId
      ? await getDraft(params.draftId, user.id, visibleIds)
      : null
    if (editing && !canEditDraft(editing, user.id, sendableIds)) {
      // Somebody else's. Readable, because it sits on an address this person
      // can read; not editable, because finishing a colleague's sentence and
      // posting it over their name is a different favour entirely.
      composePane = (
        <DraftReadOnlyView
          base={base}
          params={carried}
          draft={editing}
          authorName={staffById[editing.authorUserId] ?? 'A colleague'}
          inboxName={editing.inboxId ? allInboxes.find((i) => i.id === editing.inboxId)?.name ?? null : null}
        />
      )
    } else if (sendable.length > 0) {
      composePane = (
        <ComposeView
          base={base}
          params={carried}
          inboxes={sendable.map((i) => ({ id: i.id, name: i.name, address: i.address }))}
          defaultInboxId={chooseSendingInbox(sendableIds, editing?.inboxId ?? params.inboxId)}
          draft={editing ? forComposer(editing) : null}
        />
      )
    } else {
      // Only reachable by typing the address in, since the button that opens
      // this is not offered without somewhere to send from.
      cannotComposePane = (
        <div className="uin-empty">
          <strong>There is no address you can write from</strong>
          You can read what arrives, but sending needs an inbox shared with you to write from.
          Whoever looks after the site can put you on one.{' '}
          <Link href={inboxHref(base, carried, { compose: null, draft: null })}>Back to the inbox</Link>
        </div>
      )
    }
  }

  const currentTab = params.draftsOnly
    ? 'drafts'
    : params.sentOnly
      ? 'sent'
      : params.unroutedOnly
        ? 'none'
        : params.providerModule
          ? `m:${params.providerModule}`
          : params.inboxId

  return (
    <>
      <InboxStyles />
      <InboxTabs
        base={base}
        params={carried}
        inboxes={inboxes.map((i) => ({
          id: i.id,
          name: i.name,
          address: i.address,
          count: counts[i.id] ?? 0,
        }))}
        channels={channels.map((c) => ({
          moduleName: c.moduleName,
          label: c.label,
          count: counts[`m:${c.moduleName}`] ?? 0,
        }))}
        allCount={allUnread}
        current={currentTab}
        showUnrouted={canManage}
        unroutedCount={counts[''] ?? 0}
        showDrafts={sendable.length > 0 || draftCount > 0}
        draftCount={draftCount}
        composeHref={composeHref}
        defaultInboxId={pinnedInboxId}
        canReorder={canManage}
        canCheckNow={canManage && connections.length > 0}
        autoCheckSeconds={settings.autoCheckSeconds}
      />

      {/* Nothing above Drafts or Sent: where a conversation stands, and who it
          is assigned to, are questions about messages that have arrived. A
          message nobody has sent yet, or one already gone, has neither. */}
      {!listing && (
        <>
          <StatusTabs
            base={base}
            params={carried}
            status={params.status}
            counts={statuses}
            search={params.search}
          />
          <Filters
            base={base}
            params={carried}
            unreadOnly={params.unreadOnly}
            assignee={params.assignee}
            search={params.search}
            staff={staff}
            currentUserId={user.id}
            total={total}
          />
        </>
      )}

      <div
        className="uin"
        data-thread={params.personId || params.threadId ? 'open' : 'closed'}
        data-context={contextRail ? 'on' : 'off'}
      >
        <div className="uin-listpane">
          {params.draftsOnly ? (
            <DraftListView
              base={base}
              params={carried}
              drafts={drafts}
              inboxNames={Object.fromEntries(allInboxes.map((i) => [i.id, i.name]))}
              openThreadId={params.threadId}
              openDraftId={params.draftId}
              staffById={staffById}
              currentUserId={user.id}
              now={new Date()}
            />
          ) : params.sentOnly ? (
            <SentListView
              base={base}
              params={carried}
              rows={sent}
              total={sentTotal}
              page={params.page}
              openThreadId={params.threadId}
              inboxNames={Object.fromEntries(allInboxes.map((i) => [i.id, i.name]))}
              staffById={staffById}
              now={new Date()}
            />
          ) : (
            <ThreadListView
              base={base}
              params={carried}
              rows={rows}
              total={total}
              page={params.page}
              openThreadId={params.threadId}
              staffById={staffById}
              neverSynced={neverSynced}
              canManage={canManage}
              searching={!!params.search}
              now={new Date()}
            />
          )}
        </div>

        {cannotComposePane ?? personPane ?? threadPane}
        {contextRail}
      </div>

      {/* Over the inbox rather than in place of it: starting a message is
          something somebody does while looking at the list, and the list is
          still there underneath when it closes. */}
      {composePane}
    </>
  )
}

/** Why a conversation has nobody attached to it. Said plainly rather than left
 *  blank: an empty panel reads as broken, and every one of these is a decision
 *  somebody made on purpose. */
function reasonThereIsNobody(channel: string): string {
  if (channel !== 'email') return 'Nobody is attached to this one yet.'
  return 'Nobody is attached to this one. That happens with automatic mail, and with anything from one of your own addresses.'
}

/** Said the same way whether the person has genuinely gone or is simply not
 *  somebody this reader may know about. Telling the two apart out loud would
 *  itself be the leak. */
function personNotHere() {
  return (
    <div className="uin-empty">
      <strong>That person is not here</strong>
      They may have been merged into somebody else, or they may only appear in an inbox that has
      not been shared with you.
    </div>
  )
}
