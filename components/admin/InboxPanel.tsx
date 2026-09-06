import Link from 'next/link'
import { headers } from 'next/headers'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { prisma } from '@/lib/db/prisma'
import { getSiteTimezone } from '@/lib/config/timezone.server'
import { instantAtWallClock } from '@/lib/config/timezone'
import { getSiteUrlOrNull } from '@/lib/config/env'
import { canOpenThread, canReplyToInbox, replyableInboxIds, visibleInboxIds } from '@/modules/unified-inbox/lib/access'
import {
  attachmentsForThread,
  countDrafts,
  categoriesForPeople,
  categoriesForPerson,
  countThreadsForPerson,
  countMentions,
  defaultInboxIdFor,
  countThreads,
  draftForThread,
  draftsHeldByThread,
  getDraft,
  getPerson,
  getSettings,
  getThreadDetail,
  getOrganisation,
  linksForPerson,
  linksForThread,
  undoableThreadMerges,
  ensureCampaignTickToken,
  listConnections,
  listDrafts,
  listIdentities,
  listCategories,
  listInboxes,
  listMentions,
  listOrganisations,
  listPeople,
  listPersonEvents,
  listThreadEvents,
  listThreadMessages,
  listSentMessages,
  countSentMessages,
  listThreads,
  outboundLogForAddresses,
  peopleCount,
  peopleInOrganisation,
  setThreadRead,
  latestPhoneOnThread,
  mentionForThread,
  mentionStatusCounts,
  openMentionCount,
  statusCounts,
  threadsForPerson,
  undoableMerges,
  unreadCounts,
  wakeDueThreads,
  wakeDueMentions,
  type AttachmentRow,
} from '@/modules/unified-inbox/lib/db'
import { isSmsAvailable } from '@/lib/sms/send'
import { callerNumbers, firstDialler } from '@/lib/dialler/registry'
import { siteDiallingCode } from '@/lib/phone.server'
import { attachableKinds, loadContext } from '@/modules/unified-inbox/lib/adapters'
import { defaultLinkKind } from '@/modules/unified-inbox/lib/link-kinds'
import { modulesForInbox } from '@/modules/unified-inbox/lib/module-senders'
import { canEditDraft, forComposer } from '@/modules/unified-inbox/lib/drafts'
import { addressesForPerson, buildContextQuery } from '@/modules/unified-inbox/lib/identity'
import { ContextRail } from './inbox/ContextRail'
import { PersonView } from './inbox/PersonView'
import { ContactsToolbar } from './inbox/ContactsToolbar'
import { ColumnResizer } from './inbox/ColumnResizer'
import { ContactsListView } from './inbox/ContactsListView'
import { OrganisationsListView } from './inbox/OrganisationsListView'
import { ContactCard } from './inbox/ContactCard'
import { OrganisationCard, EMPTY_ORGANISATION } from './inbox/OrganisationCard'
import { ContactImport } from './inbox/ContactImport'
import { joinCategories, splitName } from '@/modules/unified-inbox/lib/contacts'
import { forwardSubject, replyRecipients, replySubject } from '@/modules/unified-inbox/lib/compose'
import { chooseSendingInbox, effectiveInboxParam, formatWhen, inboxHref, isSearching, NEW_CONTACT, parseInboxParams, PER_PAGE } from '@/modules/unified-inbox/lib/list'
import { providerForModule, visibleProviderChannels } from '@/modules/unified-inbox/lib/provider-registry'
import { InboxStyles } from './inbox/styles'
import { InboxIcon } from './inbox/icons'
import { NavRail } from './inbox/NavRail'
import { CampaignsPanel } from './inbox/campaigns/CampaignsPanel'
import { StatusTabs } from './inbox/StatusTabs'
import { Filters } from './inbox/Filters'
import { ThreadListView } from './inbox/ThreadListView'
import { MentionListView } from './inbox/MentionListView'
import { DraftListView } from './inbox/DraftListView'
import { SentListView } from './inbox/SentListView'
import { ThreadPane, type ThreadMessageView } from './inbox/ThreadPane'
import { ComposeView } from './inbox/ComposeView'
import { DiscussionView } from './inbox/DiscussionView'
import { SmsView } from './inbox/SmsView'
import { CallView } from './inbox/CallView'
import { DraftReadOnlyView } from './inbox/DraftReadOnlyView'

// The hub's tab on core's Inbox page. One framed box the height of the window,
// divided into four: the rail of addresses and places to go, the head and list
// of whichever one is chosen, whatever was opened from it, and what the rest of
// the site knows about whoever sent it. Each pane scrolls its own contents, so
// the row somebody is reading and the message they opened stay level with one
// another - which a page that scrolls as one cannot do.
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
  // Read once and handed to every view below. This panel and everything under
  // it are server-rendered, so a clock time left to the machine's own zone comes
  // out in UTC - an hour behind the site for most of the year.
  const timezone = await getSiteTimezone()
  const canManage = await hasPermission(user, 'unifiedinbox.manage')
  // Whether this person may put anything OUT of the building at all - a reply,
  // a text, a call. Asked once and reused: it decides three different things
  // further down, and three copies of the same question is three round trips.
  const canSendOut = await hasPermission(user, 'unifiedinbox.reply')
  const canEditLinks = canManage || canSendOut
  // Its own grant. Renaming a folder and emailing five thousand customers are
  // not the same act, and a site that gives somebody the first has not thereby
  // given them the second.
  const canCampaign = await hasPermission(user, 'unifiedinbox.campaigns')

  // Anything whose snooze has elapsed is open again by the time the list is
  // drawn. Doing it here rather than on a tick means a conversation is back the
  // moment somebody looks, which is the only moment it matters. The same is
  // true of something a colleague was asked to look at and put off until
  // Thursday, so the two sweeps run together.
  await Promise.all([wakeDueThreads(), wakeDueMentions()])

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
  for (const key of [
    'inbox', 'status', 'unread', 'assignee', 'q', 'sort', 'page', 'id', 'person',
    // The search dialog's narrower cuts, so a search survives opening one of
    // the conversations it found and coming back to the list.
    'from', 'to', 'subject', 'att', 'after', 'before',
    // The address book's own: which half of it, whose card is open, whether the
    // card is being edited, and whether the importer is up.
    'view', 'org', 'edit', 'import', 'cat',
    // Which campaign is open, and which of its four steps.
    'campaign',
  ] as const) {
    const value = chosen[key]
    if (value) carried[key] = value
  }

  const staffRows = await prisma.user.findMany({
    where: { suspendedAt: null },
    select: {
      id: true,
      displayName: true,
      username: true,
      roleId: true,
      role: { select: { isProtected: true } },
    },
    orderBy: { username: 'asc' },
  })
  const staff = staffRows.map((s) => ({ id: s.id, name: s.displayName || s.username }))
  const staffById = Object.fromEntries(staff.map((s) => [s.id, s.name]))

  // Who can be ASKED to look at something, which is not everybody with an
  // account. A tag lands on somebody's own list inside this hub, so tagging a
  // colleague who has never been given the hub tells them nothing at all - and
  // a picker offering a name that quietly does nothing is worse than one that
  // does not offer it. One query for every role that holds the grant, rather
  // than one question per colleague.
  const hubRoleIds = new Set(
    (await prisma.rolePermission.findMany({
      where: { permissionKey: { in: ['unifiedinbox.view', 'unifiedinbox.manage'] } },
      select: { roleId: true },
    })).map((row) => row.roleId),
  )
  const taggable = staffRows
    .filter((person) => person.role.isProtected || hubRoleIds.has(person.roleId))
    .map((person) => ({ id: person.id, name: person.displayName || person.username }))

  const counts = await unreadCounts(visibleIds, canManage, channelModules)
  const allUnread = Object.values(counts).reduce((a, b) => a + b, 0)

  // What has been handed to whoever is reading, across every address they can
  // see. "Assigned to me" is a place in the rail rather than a filter chip now,
  // and a place with no number beside it is a place nobody visits.
  const assignedCount = await countThreads({
    inboxIds: visibleIds,
    includeUnrouted: canManage,
    providerModules: channelModules,
    assignee: user.id,
    status: 'open',
    page: 1,
    perPage: PER_PAGE,
  })

  // What colleagues have asked this person to look at and they have not dealt
  // with yet. One cheap COUNT on every draw, because it rides on the rail; the
  // list itself is only fetched when that is the tab open, the same as Drafts,
  // Sent and Contacts.
  const askedCount = await openMentionCount(user.id)

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

  // The three other things the button can start, narrowed to the ones this site
  // can actually do. Both questions are asked the CHEAP way here - is there a
  // module that sends texts, is there a module that places calls - rather than
  // by reaching a telephony API to ask whether it is configured, because this
  // runs on every draw of every list. The expensive question is asked by the
  // screen that opens, where somebody is waiting for an answer anyway.
  //
  // A discussion needs nothing switched on: it is an internal note, and this
  // module has always been able to write one. It does need somewhere to put it,
  // which on a site where this person can read nothing is nowhere.
  const [smsReady, dialler] = canSendOut
    ? await Promise.all([isSmsAvailable(), firstDialler(user)])
    : [false, null]
  const composeEntries = composeHref === null ? [] : [
    ...(visibleIds.length > 0 ? [{
      key: 'discussion',
      label: 'Discussion',
      href: inboxHref(base, carried, { compose: 'discussion', draft: null, id: null, person: null }),
      hint: 'A word with your colleagues. The customer never sees it.',
    }] : []),
    ...(dialler ? [{
      key: 'call',
      label: 'Call',
      href: inboxHref(base, carried, { compose: 'call', draft: null, id: null, person: null }),
      hint: 'We ring you, then them.',
    }] : []),
    ...(smsReady ? [{
      key: 'sms',
      label: 'SMS',
      href: inboxHref(base, carried, { compose: 'sms', draft: null, id: null, person: null }),
      hint: 'A text message to a mobile.',
    }] : []),
  ]

  // ---- one colleague's folders ------------------------------------------
  //
  // Sent, Drafts and Mentioned can each be looked at across every address this
  // person may read - which is what they have always been - or narrowed to ONE
  // address, which is what the folders under a colleague's name on the rail
  // ask for.
  //
  // The id is resolved against the addresses this person may read rather than
  // trusted. Anybody can type one into the address bar, and a Sent folder that
  // quietly fell back to everything because the id did not resolve is the E17
  // breach wearing a folder's name - so an id that is not on their list yields
  // nothing at all rather than something.
  const folderAsked = params.folderInboxId !== null
  const folderInbox = params.folderInboxId && visible.has(params.folderInboxId)
    ? allInboxes.find((i) => i.id === params.folderInboxId) ?? null
    : null
  const folderIds = folderAsked ? (folderInbox ? [folderInbox.id] : []) : visibleIds
  // Whose asks the Mentioned list is of. This reader's own on their own tab;
  // the address's owner on a colleague's. An address whose owner's account has
  // gone belongs to nobody, so there is nobody to have been asked - and the
  // rail does not offer the folder in that case either.
  const folderOwnerId = folderAsked ? folderInbox?.ownerUserId ?? null : user.id
  // The name at the head of a colleague's folder, and the one the Mentioned
  // rows are written in. Null on this person's own lists, which say "you".
  const folderOwnerName = folderAsked && folderInbox
    ? (folderInbox.ownerUserId ? staffById[folderInbox.ownerUserId] ?? null : null) ?? folderInbox.name
    : null

  // Drafts filed on an address are read by whoever can read that address, the
  // same as every other message on it, and the query says so rather than the
  // caller (see lib/db.ts). The count is what the Drafts tab shows; the list
  // itself is only fetched when that tab is the one open.
  const draftCount = await countDrafts(user.id, visibleIds)
  const drafts = params.draftsOnly
    ? await listDrafts(user.id, folderIds, !folderAsked)
    : []

  // Everything that has left, across every address this person may read, or out
  // of the one a colleague's folder names. Only fetched when that is the list
  // being looked at.
  const [sent, sentTotal] = params.sentOnly
    ? await Promise.all([
        listSentMessages(folderIds, !folderAsked && canManage, folderAsked ? [] : channelModules, params.page, PER_PAGE),
        countSentMessages(folderIds, !folderAsked && canManage, folderAsked ? [] : channelModules),
      ])
    : [[] as Awaited<ReturnType<typeof listSentMessages>>, 0]

  // Everything colleagues have asked this person about, when that is the list
  // being looked at. Scoped to them in the SQL rather than after it, like every
  // other list on this screen (E17) - this table is the one place that knows a
  // colleague was let into a conversation their inbox guest list does not
  // cover, and a row of it belongs to exactly one person.
  const [asks, askTotal, askCounts] = params.mentionsOnly && folderOwnerId
    ? await Promise.all([
        listMentions({
          userId: folderOwnerId,
          status: params.status,
          page: params.page,
          perPage: PER_PAGE,
          inboxId: folderInbox?.id ?? null,
        }),
        countMentions(folderOwnerId, params.status, folderInbox?.id ?? null),
        mentionStatusCounts(folderOwnerId, folderInbox?.id ?? null),
      ])
    : [[] as Awaited<ReturnType<typeof listMentions>>, 0, {} as Record<string, number>]

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
    fromText: params.fromText,
    toText: params.toText,
    subjectText: params.subjectText,
    withAttachment: params.withAttachment,
    // The two ends of the range become instants HERE, because that takes the
    // site's timezone: a calendar date read as UTC starts an hour late through
    // British Summer Time and drops the first message of the day. "Up to and
    // including" means the whole of the day somebody named, so it runs to the
    // end of it rather than to its first second.
    after: params.after ? instantAtWallClock(params.after, '00:00', timezone) : null,
    before: params.before ? instantAtWallClock(params.before, '24:00', timezone) : null,
    oldestFirst: params.oldestFirst,
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
  const listing = params.draftsOnly || params.sentOnly || params.contactsOnly || params.campaignsOnly
    || params.mentionsOnly
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

  // ---- the address book -------------------------------------------------
  //
  // The count rides on the tab row and is asked for on every render, which is
  // one cheap COUNT; the lists themselves are only fetched when the Contacts tab
  // is the one open, the same as Drafts and Sent above.
  // Both counts in one query - one of them rides on the hub's own tab row, so
  // it is asked for on every render either way and there is no sense in two.
  const { people: contactCount, organisations: organisationCount } = await peopleCount()
  const showingOrganisations = params.contactsOnly && params.contactsView === 'organisations'
  const [contacts, contactsTotal] = params.contactsOnly && !showingOrganisations
    ? await listPeople({
        search: params.search,
        page: params.page,
        perPage: PER_PAGE,
        // Surname order, because that is what an address book is for. The
        // conversation lists order by when something last happened; a contacts
        // list ordered that way is a list nobody can find anybody in.
        sort: 'name',
        organisationId: params.organisationId,
        categoryId: params.categoryId,
      }).then((r) => [r.rows, r.total] as const)
    : [[] as Awaited<ReturnType<typeof listPeople>>['rows'], 0]
  // The labels: the whole list for the filter row, and the page's own in one
  // query rather than one per row.
  const categoryList = params.contactsOnly || params.campaignsOnly ? await listCategories() : []
  const contactCategories = contacts.length > 0
    ? await categoriesForPeople(contacts.map((c) => c.id))
    : {}
  const [organisations, organisationsTotal] = params.contactsOnly && showingOrganisations
    ? await listOrganisations({ search: params.search, page: params.page, perPage: PER_PAGE })
        .then((r) => [r.rows, r.total] as const)
    : [[] as Awaited<ReturnType<typeof listOrganisations>>['rows'], 0]

  // ---- one person's own page, if the address asks for one ----------------
  //
  // It takes the same place on the screen as a conversation, because it answers
  // the same question about the same human from a different angle: what have we
  // said to each other, and what does the rest of the site know about them.
  let personPane: React.ReactNode = null
  if (params.personId === NEW_CONTACT && !params.composing) {
    // A blank card. Writing in the address book is the same grant as answering
    // somebody, so anybody who may reply may add a contact.
    personPane = canEditLinks
      ? <ContactCard base={base} params={carried} personId={null} initial={{}} />
      : cannotWriteInTheBook()
  } else if (params.personId && !params.composing) {
    const person = await getPerson(params.personId)
    if (!person) {
      personPane = personNotHere()
    } else {
      const personThreads = await threadsForPerson(person.id, visibleIds, canManage, channelModules)
      // A person's page is reachable by anybody who may read the inbox, so it
      // needs the same gate the conversations themselves have. Otherwise
      // somebody who can only open hi@ learns the name, the addresses and the
      // subject lines of a supplier who has only ever written to accounts@ -
      // which is the breach in E17 wearing a different hat.
      //
      // Having no conversations THIS READER may see and having none at all are
      // two different answers, and they are asked apart. They used to be one
      // question, which was right while the only way to become a contact was to
      // write in - and became wrong the moment somebody could be added by hand,
      // because a contact typed in this morning has no mail against them and
      // was hidden from everybody but an administrator.
      const hidden = personThreads.length === 0
        && !canManage
        && await countThreadsForPerson(person.id) > 0
      if (hidden) {
        personPane = personNotHere()
      } else if (params.editingContact && canEditLinks) {
        // Somebody the post introduced us to may never have had their name
        // split, so the card opens with a first and last worked out from what
        // we do have rather than with two empty boxes.
        const split = splitName(person.displayName)
        // Their labels have to arrive filled in, or the picker shows every one
        // of them unticked and saving the card would take the lot off.
        const worn = await categoriesForPerson(person.id)
        personPane = (
          <ContactCard
            base={base}
            params={carried}
            personId={person.id}
            initial={{
              firstName: person.firstName ?? split.firstName,
              lastName: person.lastName ?? split.lastName,
              jobTitle: person.jobTitle ?? '',
              organisation: person.organisationName ?? '',
              categories: joinCategories(worn.map((c) => c.name)),
              email: person.primaryEmail ?? '',
              website: person.website ?? '',
              addressLine1: person.addressLine1 ?? '',
              addressLine2: person.addressLine2 ?? '',
              addressCity: person.addressCity ?? '',
              addressCounty: person.addressCounty ?? '',
              addressPostcode: person.addressPostcode ?? '',
              addressCountry: person.addressCountry ?? '',
              notes: person.notes ?? '',
            }}
          />
        )
      } else {
      const query = await buildContextQuery(person.id)
      const [identities, sections, links, events, merges, worn, alsoHere, addresses] =
        await Promise.all([
          listIdentities(person.id),
          query ? loadContext(user, query) : Promise.resolve([]),
          linksForPerson(person.id),
          listPersonEvents(person.id),
          canManage ? undoableMerges(person.id) : Promise.resolve([]),
          categoriesForPerson(person.id),
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
          categories={worn}
          alsoHere={alsoHere}
          staffById={staffById}
          canEdit={canEditLinks}
          canManage={canManage}
          now={new Date()}
          timezone={timezone}
        />
      )
      }
    }
  }

  // ---- an organisation's own card, and the importer -----------------------
  //
  // Both take the same place on the screen as a conversation does, for the same
  // reason the person page does: they are the thing being looked at, and the
  // list on the left is still the list they came from.
  let organisationPane: React.ReactNode = null
  if (params.contactsOnly && params.organisationId === NEW_CONTACT) {
    organisationPane = canEditLinks
      ? (
        <OrganisationCard
          base={base}
          params={carried}
          organisationId={null}
          initial={EMPTY_ORGANISATION}
          peopleCount={0}
          canDelete={false}
        />
      )
      : cannotWriteInTheBook()
  } else if (params.contactsOnly && params.organisationId && showingOrganisations) {
    const organisation = await getOrganisation(params.organisationId)
    organisationPane = organisation
      ? (
        <OrganisationCard
          base={base}
          params={carried}
          organisationId={organisation.id}
          initial={{
            name: organisation.name,
            domain: organisation.domain ?? '',
            email: organisation.email ?? '',
            phone: organisation.phone ?? '',
            website: organisation.website ?? '',
            addressLine1: organisation.addressLine1 ?? '',
            addressLine2: organisation.addressLine2 ?? '',
            addressCity: organisation.addressCity ?? '',
            addressCounty: organisation.addressCounty ?? '',
            addressPostcode: organisation.addressPostcode ?? '',
            addressCountry: organisation.addressCountry ?? '',
            notes: organisation.notes ?? '',
          }}
          peopleCount={organisations.find((o) => o.id === organisation.id)?.peopleCount ?? 0}
          canDelete={canManage}
        />
      )
      : (
        <div className="uin-empty">
          <strong>That organisation is not here</strong>
          It may have been removed since this list was drawn.
        </div>
      )
  }

  let importPane: React.ReactNode = null
  if (params.contactsOnly && params.importing) {
    // Bringing two thousand contacts in on one press is a wider act than
    // correcting one of them, and an import run against the wrong column
    // mapping is the easiest way there is to make a mess of an address book.
    importPane = canManage
      ? <ContactImport base={base} params={carried} />
      : (
        <div className="uin-empty">
          <strong>You cannot import contacts</strong>
          Bringing a whole address book in is something whoever looks after the site does.
        </div>
      )
  }

  // ---- the conversation on the right, if the address asks for one ---------
  let threadPane: React.ReactNode = null
  let contextRail: React.ReactNode = null
  if (!params.composing && !params.personId && params.threadId) {
    // A link to a conversation that has since been merged into another opens
    // the one it became. Without this a bookmark, a search result somebody
    // pasted into a chat, or a notification from before the merge lands on a
    // conversation no list shows, holding at most the duplicate copies the
    // merge could not move - which reads as a conversation that has lost its
    // messages rather than one that was tidied up.
    const opened = await getThreadDetail(params.threadId)
    const thread = opened?.mergedIntoId
      ? await getThreadDetail(opened.mergedIntoId)
      : opened
    // The whole rule in one call rather than a copy of it here: the guest list,
    // the channel's own permission, and - since colleagues can tag each other -
    // whether this person was asked to look at this one conversation. The copy
    // that used to live here would have let somebody follow a link to a
    // conversation they had been asked about and be told it was not there.
    const allowed = thread ? await canOpenThread(user, thread) : false
    if (!thread || !allowed) {
      threadPane = (
        <div className="uin-empty">
          <strong>That conversation is not here</strong>
          It may have been removed, or it may be in an inbox that has not been shared with you.
        </div>
      )
    } else {
      // Opening a conversation is what marks it read, which is what everybody
      // means by opening one. Taken first, because where the pane opens turns on
      // it and it stops being true one line below.
      const wasUnread = thread.unread
      if (thread.unread) await setThreadRead(thread.id, false)

      const [messages, files, events, ownDraft, heldDrafts] = await Promise.all([
        listThreadMessages(thread.id),
        attachmentsForThread(thread.id),
        listThreadEvents(thread.id),
        draftForThread(thread.id, user.id, sendableIds),
        // Anything that was queued to this person and stood down when this
        // arrived. Read through the same visibility rule as every other way of
        // reaching a draft, so the warning is not a way of learning that a
        // colleague has one on an address this reader cannot open.
        draftsHeldByThread(thread.id, user.id, visibleIds),
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

      // Which message the pane opens on. Reading newest first it is already the
      // one at the top and there is nothing to do; reading oldest first the
      // newest message is at the BOTTOM, so a conversation with forty messages
      // in it opens four thousand pixels from the one that has just arrived.
      //
      // Unread when it was opened means something came in that nobody has read,
      // so that is what it opens on. Otherwise it is the last message of any
      // kind - a colleague's note included, since a note is the most recent
      // thing said about the conversation whether or not it was sent anywhere.
      const openOnMessage = settings.newestFirst
        ? null
        : (wasUnread ? [...messages].reverse().find((m) => m.direction === 'in') : null)
          ?? messages[messages.length - 1]
          ?? null

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

      // What the subject line would say if nobody opened it in the reply box,
      // worked out the same way the send route works it out: off the message
      // being answered, falling back to the conversation's own. The box only
      // shows it once somebody asks to change it, but it has to be the same
      // words the server would have used or opening the line would silently
      // rewrite the subject.
      const replySubjectLine = replySubject(newest?.subject ?? thread.subject)
      const forwardSubjectLine = forwardSubject(newest?.subject ?? thread.subject)

      const channel = thread.providerModule
        ? channels.find((c) => c.moduleName === thread.providerModule) ?? null
        : null
      // A discussion has nobody outside it to answer, so there is nothing to
      // send and no Reply to offer. What is left is the note box, which is what
      // a discussion is made of anyway - so the composer arrives on the one mode
      // that applies rather than on a Reply that would refuse.
      const isDiscussion = thread.channel === 'discussion'
      const canReply = isDiscussion
        ? false
        : thread.providerModule
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
        : isDiscussion
        ? 'This is a discussion between colleagues. Nothing on it is ever sent to anybody outside.'
        : thread.providerModule
          ? channel
            ? `${channel.label} conversations are read here and answered where they came from.`
            : 'The part of the site that handles this channel is no longer installed, so this cannot be answered here.'
          : thread.inboxId
            ? 'You can read this inbox but not send from it. Leave a note instead, or ask whoever looks after the site.'
            : 'This conversation is not filed in one of your addresses, so there is nothing to send it from.'

      // A conversation in somebody's own inbox has nobody to hand it to: the
      // one person who can open it is the one it already belongs to. Offering
      // the rest of the team is offering a name that would make the
      // conversation vanish from the only screen it is on.
      const threadInbox = thread.inboxId
        ? allInboxes.find((i) => i.id === thread.inboxId) ?? null
        : null
      const threadStaff = threadInbox && threadInbox.kind === 'individual'
        ? staff.filter((s) => s.id === threadInbox.ownerUserId)
        : staff

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
      // This reader's own ask on this conversation, when a colleague put their
      // name on it. Nobody else's: what somebody was asked and whether they
      // have got to it is between them and whoever asked them.
      const ask = await mentionForThread(user.id, thread.id)

      const [sections, links, kindOptions, senderModules, merges] = await Promise.all([
        query ? loadContext(user, query) : Promise.resolve([]),
        linksForThread(thread.id),
        canEditLinks ? attachableKinds(user) : Promise.resolve([]),
        canEditLinks && thread.inboxId ? modulesForInbox(thread.inboxId) : Promise.resolve([]),
        // Only asked for when there is somebody who could act on the answer.
        canManage ? undoableThreadMerges(thread.id) : Promise.resolve([]),
      ])

      // The site's other addresses this conversation belongs to. Its own is
      // already named beside the channel, so only the extras go here.
      const otherInboxNames = thread.absorbedInboxIds
        .filter((id) => id !== thread.inboxId)
        .map((id) => allInboxes.find((i) => i.id === id)?.name)
        .filter((name): name is string => !!name)

      threadPane = (
        <ThreadPane
          base={base}
          params={carried}
          thread={thread}
          inboxName={threadInbox?.name ?? null}
          otherInboxNames={otherInboxNames}
          merges={merges.map((merge) => ({
            id: merge.id,
            subject: merge.loserSubject,
            // A Date in props reaches a client component as an empty object.
            when: formatWhen(merge.createdAt, new Date(), timezone),
            by: merge.userId ? staffById[merge.userId] ?? null : null,
          }))}
          messages={view}
          events={events}
          staff={threadStaff}
          /* The full list, not the narrowed one: a tag is how somebody outside
             an address is asked to look at one conversation in it, and on a
             private inbox the narrowed list is this reader on their own. */
          taggable={taggable}
          staffById={staffById}
          canReply={canReply}
          cannotReplyReason={cannotReplyReason}
          replyTo={[...reply.to, ...reply.cc]}
          replyAllTo={[...replyAll.to, ...replyAll.cc]}
          replySubject={replySubjectLine}
          forwardSubject={forwardSubjectLine}
          draft={ownDraft ? forComposer(ownDraft) : null}
          newestFirst={settings.newestFirst}
          scrollToMessageId={openOnMessage?.id ?? null}
          showAvatars={settings.showAvatars}
          canDeleteMessages={canDeleteMessages}
          blockState={blockState}
          now={new Date()}
          timezone={timezone}
          heldDrafts={heldDrafts.map((held) => ({
            id: held.id,
            threadId: held.threadId,
            to: held.to,
            subject: held.subject,
            // A Date in props arrives at a client component as an empty object,
            // and this pane is rendered on the server for one that is not - so
            // it makes the trip as a string either way.
            sendAt: held.sendAt ? held.sendAt.toISOString() : null,
          }))}
          asked={ask && {
            id: ask.id,
            status: ask.status,
            note: ask.note,
            askedBy: ask.byUserId ? staffById[ask.byUserId] ?? null : null,
            backWhen: ask.snoozeUntil ? formatWhen(ask.snoozeUntil, new Date(), timezone) : null,
          }}
          context={{
            adminPath,
            links,
            canEditLinks,
            linkKinds: kindOptions,
            defaultLinkKind: defaultLinkKind(kindOptions, senderModules),
          }}
        />
      )

      // The panel is what the rest of the site knows ABOUT this person, and it
      // is only drawn when there is somebody for it to be about: the records
      // attached to the conversation itself now sit in the conversation's own
      // header, so without a person this would be a column of ground holding
      // one sentence about nobody.
      contextRail = person ? (
        <ContextRail
          adminPath={adminPath}
          threadId={thread.id}
          sections={sections}
          /* A conversation's attached records are in its header. */
          links={[]}
          canEditLinks={canEditLinks}
        />
      ) : null
    }
  }

  // ---- writing a brand new one, if the address asks for it ---------------
  let composePane: React.ReactNode = null
  // Said in the reading pane rather than in a dialog of its own. It was a box
  // dressed as a dialog with no Escape, no focus moved into it and nothing
  // labelling it, which is a dialog in looks only - and there is nothing here to
  // answer, only something to be told.
  let cannotComposePane: React.ReactNode = null
  if (params.composing && params.composeKind !== 'email') {
    // The three short ones. Each is refused rather than drawn empty when the
    // site cannot do it - a form that ends in "this site cannot send texts" is
    // a form somebody filled in for nothing.
    const knownPhone = params.threadId && params.composeKind !== 'discussion'
      ? await latestPhoneOnThread(params.threadId)
      : null

    if (params.composeKind === 'discussion') {
      composePane = visibleIds.length > 0 ? (
        <DiscussionView
          base={base}
          params={carried}
          /* Every address this person may READ, not only the ones they may send
             from: a discussion is a note, and a note goes nowhere. */
          inboxes={inboxes
            .filter((i) => visibleIds.includes(i.id))
            .map((i) => ({ id: i.id, name: i.name, address: i.address }))}
          defaultInboxId={params.inboxId ?? pinnedInboxId}
          /* The names here are people to ASK, not people to hand it to, so it
             is the list of colleagues who can actually use the hub. */
          staff={taggable}
        />
      ) : (
        <div className="uin-empty">
          <strong>There is no address to have this in</strong>
          A discussion sits in one of the site&apos;s addresses, and you have not been given one to
          read. Whoever looks after the site can put you on one.{' '}
          <Link href={inboxHref(base, carried, { compose: null, draft: null })}>Back to the inbox</Link>
        </div>
      )
    } else if (params.composeKind === 'sms') {
      composePane = smsReady ? (
        <SmsView base={base} params={carried} defaultTo={knownPhone} />
      ) : (
        <div className="uin-empty">
          <strong>This site cannot send texts</strong>
          Nothing here is set up to send one yet. Whoever looks after the site can switch that on.{' '}
          <Link href={inboxHref(base, carried, { compose: null, draft: null })}>Back to the inbox</Link>
        </div>
      )
    } else {
      // The expensive question, asked here rather than on every draw of the
      // rail: which of the site's numbers can actually place a call. Empty and
      // this is a screen saying so, which is the honest answer whether the
      // cause is no credentials or no number.
      const numbers = dialler ? await callerNumbers(user) : []
      // Their own number and the site's dialling code, so the form arrives
      // filled in and reads a number typed the way people type one. Both are
      // core's - this module keeps no phone book of its own for staff.
      const [me, diallingCode] = numbers.length > 0
        ? await Promise.all([
          prisma.user.findUnique({ where: { id: user.id }, select: { phone: true } }),
          siteDiallingCode(),
        ])
        : [null, '']
      composePane = numbers.length > 0 ? (
        <CallView
          base={base}
          params={carried}
          numbers={numbers}
          defaultTo={knownPhone}
          defaultCallMeAt={me?.phone ?? null}
          diallingCode={diallingCode}
          accountHref={`/${adminPath}/account`}
        />
      ) : (
        <div className="uin-empty">
          <strong>There is no number to call from</strong>
          Calls go out as one of the site&apos;s own numbers, and there is not one to use yet.
          Whoever looks after the site can add one.{' '}
          <Link href={inboxHref(base, carried, { compose: null, draft: null })}>Back to the inbox</Link>
        </div>
      )
    }
  } else if (params.composing) {
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
          now={new Date()}
          timezone={timezone}
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
          timezone={timezone}
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

  // A folder under a colleague's name says which folder AND whose, in one
  // value, because the rail highlights one entry and there are three of them
  // under every colleague.
  const folderTab = params.draftsOnly ? 'drafts' : params.sentOnly ? 'sent' : 'mentions'
  const currentTab = params.folderInboxId
    ? `${folderTab}:${params.folderInboxId}`
    : params.draftsOnly
    ? 'drafts'
    : params.sentOnly
      ? 'sent'
      : params.contactsOnly
        ? 'contacts'
        : params.campaignsOnly
          ? 'campaigns'
          : params.mentionsOnly
          ? 'mentions'
          : params.unroutedOnly
            ? 'none'
            : params.providerModule
              ? `m:${params.providerModule}`
              : params.inboxId

  // What the head of the list column says it is a list of, and how much of it
  // there is. The rail says where you are as well, in a highlight; this says it
  // in words, above the rows it describes, which is where somebody reading the
  // list is already looking.
  const currentInbox = params.inboxId ? allInboxes.find((i) => i.id === params.inboxId) ?? null : null
  const currentChannel = params.providerModule
    ? channels.find((c) => c.moduleName === params.providerModule) ?? null
    : null
  // Whose folder it is, said in front of which folder it is: "Sam Blake ·
  // Sent". The name first because on this screen the surprising half is whose
  // post you are looking at, not that it is the sent one.
  const folderPrefix = folderOwnerName ? `${folderOwnerName} \u00b7 ` : ''
  const viewTitle = params.draftsOnly
    ? `${folderPrefix}Drafts`
    : params.sentOnly
      ? `${folderPrefix}Sent`
      : params.contactsOnly
        ? (showingOrganisations ? 'Organisations' : 'Contacts')
        : params.mentionsOnly
          ? `${folderPrefix}Mentioned`
          : params.unroutedOnly
          ? 'Not filed'
          : currentChannel
            ? currentChannel.label
            : currentInbox
              ? currentInbox.name
              : 'All conversations'
  const headTotal = params.draftsOnly
    ? plural(drafts.length, 'draft', 'drafts')
    : params.sentOnly
      ? plural(sentTotal, 'message', 'messages')
      : params.contactsOnly
        ? (showingOrganisations
            ? plural(organisationsTotal, 'organisation', 'organisations')
            : plural(contactsTotal, 'contact', 'contacts'))
        : params.mentionsOnly
          ? plural(askTotal, 'conversation', 'conversations')
          : plural(total, 'conversation', 'conversations')

  // The rail, built once and used by both shapes this screen takes: the
  // ordinary reading layout, and campaigns, which is one full-width column
  // rather than a list beside a conversation.
  const rail = (
    <NavRail
      base={base}
      params={carried}
      inboxes={inboxes.map((i) => ({
        id: i.id,
        name: i.name,
        address: i.address,
        kind: i.kind,
        ownerUserId: i.ownerUserId,
        /* The colleague's name, for the Team inboxes group. Null when the
           account behind the address has gone, and the rail then falls back to
           what the address is called. */
        ownerName: i.ownerUserId ? staffById[i.ownerUserId] ?? null : null,
        count: counts[i.id] ?? 0,
      }))}
      channels={channels.map((c) => ({
        moduleName: c.moduleName,
        label: c.label,
        count: counts[`m:${c.moduleName}`] ?? 0,
      }))}
      allCount={allUnread}
      current={currentTab}
      me={{ id: user.id, name: staffById[user.id] ?? 'You' }}
      showAvatars={settings.showAvatars}
      assignedCount={assignedCount}
      askedCount={askedCount}
      assignee={params.assignee}
      showUnrouted={canManage}
      unroutedCount={counts[''] ?? 0}
      showDrafts={sendable.length > 0 || draftCount > 0}
      draftCount={draftCount}
      contactCount={contactCount}
      showCampaigns={canCampaign}
      /* At the head of the rail, on every list: starting a message is the one
         thing up there that is not a place to go, and it is the same act
         whichever list somebody is standing in. */
      composeHref={composeHref}
      composeEntries={composeEntries}
      defaultInboxId={pinnedInboxId}
      canReorder={canManage}
      canCheckNow={canManage && connections.length > 0}
      autoCheckSeconds={settings.autoCheckSeconds}
    />
  )

  // The campaigns tab takes the whole width. Nothing on it is a conversation,
  // so the list-and-reading-pane layout below has nothing to put in either
  // half - and the address a pinger can be pointed at is minted here, on the
  // one screen that explains what it is for.
  if (params.campaignsOnly) {
    if (!canCampaign) {
      return (
        <div className="uin-page">
          <InboxStyles />
          <ColumnResizer handles={false} />
          <div className="uin-app uin-app-wide">
            {rail}
            <div className="uin-read uin-read-pad">
              <div className="alert alert-danger">You do not have permission to send campaigns.</div>
            </div>
          </div>
        </div>
      )
    }
    const siteUrl = getSiteUrlOrNull()
    const tickToken = siteUrl ? await ensureCampaignTickToken() : null
    return (
      <div className="uin-page">
        <InboxStyles />
        {/* The rail stays; everything else on this screen is one long form with
            a save bar of its own pinned to the bottom of it, so it keeps the
            page's own scroll rather than being put inside a second one. */}
        {/* No handles on this screen - its only edge is the rail's, and a
            full-height grab bar down a long form is not worth having - but it
            still applies the width somebody set in the inbox, or the rail would
            spring back to its shipped size every time they opened Campaigns. */}
        <ColumnResizer handles={false} />
        <div className="uin-app uin-app-wide">
          {rail}
          <div className="uin-read uin-read-pad">
            <CampaignsPanel
              base={base}
              params={carried}
              inboxes={sendable.map((i) => ({ id: i.id, name: i.name, address: i.address }))}
              categories={categoryList.map((c) => ({ id: c.id, name: c.name }))}
              campaignId={params.campaignId}
              view={searchParams.view ?? null}
              tickUrl={siteUrl && tickToken
                ? `${siteUrl}/api/m/unified-inbox/cron/campaigns?key=${tickToken}`
                : null}
            />
          </div>
        </div>
      </div>
    )
  }

  // The list itself, whichever of the four it is. Built here rather than inline
  // so the column below reads as head-then-list rather than as a hundred lines
  // of conditional with a wrapper somewhere in the middle of it.
  const listView = params.contactsOnly ? (
    showingOrganisations ? (
      <OrganisationsListView
        base={base}
        params={carried}
        rows={organisations}
        total={organisationsTotal}
        page={params.page}
        openOrganisationId={params.organisationId}
        searching={!!params.search}
        canEdit={canEditLinks}
      />
    ) : (
      <ContactsListView
        base={base}
        params={carried}
        rows={contacts}
        showAvatars={settings.showAvatars}
        categories={contactCategories}
        total={contactsTotal}
        page={params.page}
        openPersonId={params.personId}
        searching={!!params.search}
        canEdit={canEditLinks}
      />
    )
  ) : params.mentionsOnly ? (
    <MentionListView
      base={base}
      params={carried}
      rows={asks}
      total={askTotal}
      page={params.page}
      openThreadId={params.threadId}
      staffById={staffById}
      inboxNames={Object.fromEntries(allInboxes.map((i) => [i.id, i.name]))}
      status={params.status}
      /* Whose list it is. Null on this reader's own, which says "you"; a
         colleague's name on theirs, where the controls also come off - where
         somebody else's job stands is between them and whoever asked, and a
         button that the route would refuse is worse than no button. */
      ownerName={folderOwnerName}
      canSettle={!folderAsked}
      now={new Date()}
      timezone={timezone}
    />
  ) : params.draftsOnly ? (
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
      timezone={timezone}
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
      timezone={timezone}
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
      inboxNames={Object.fromEntries(allInboxes.map((i) => [i.id, i.name]))}
      showAvatars={settings.showAvatars}
      neverSynced={neverSynced}
      canManage={canManage}
      /* Any of the cuts, not only the words: "nothing matches that" is the
         honest answer to a date range that catches nothing too, and "nothing
         here" in front of a narrowed list reads as an empty inbox. */
      searching={isSearching(params)}
      now={new Date()}
      timezone={timezone}
    />
  )

  // Everything that is not a conversation but takes a conversation's place: a
  // person's page, a contact card, an organisation, the importer, and the one
  // apology for a compose window somebody cannot have. The first four wear a
  // conversation's own header and body, so they need nothing round them; the
  // bare notices are given their air by .uin-read > .uin-empty in the
  // stylesheet rather than by a wrapper only some of them would want.
  const otherPane = cannotComposePane ?? importPane ?? organisationPane ?? personPane
  // Whether the right-hand half is showing something, which on a phone is the
  // difference between showing the list and showing what was opened from it.
  const opened = !!otherPane || !!threadPane

  return (
    // Everything this module puts on the page lives in one box that cannot be
    // wider than the page it is on. Every region inside already handles its own
    // overflow - the rail scrolls, the rows end in an ellipsis, the tables sit
    // in their own scroller - so what this catches is bleed rather than content:
    // one stray element a few hundred pixels too wide used to give the WHOLE
    // admin page a horizontal scrollbar and a screenful of nothing to the right
    // of it. `clip` rather than `hidden` on purpose: hidden would make this a
    // scroll container and kill the sticky frame inside it.
    <div className="uin-page">
      <InboxStyles />

      <div className="uin-app" data-open={opened ? '1' : '0'} data-context={contextRail ? 'on' : 'off'}>
        {rail}

        <div className="uin-col">
          <div className="uin-col-head">
            {/* A name for the list only where nothing else in the head says
                one. Drafts and Sent have no tabs and no counts, so without this
                they are an unlabelled column of rows; everywhere else the tab
                row carries the total and the rail carries the name, and a third
                thing saying it is a third thing to read. */}
            {/* A colleague's Mentioned list is the one that DOES want a title
                over its tabs: the tabs say where the jobs stand and nothing
                else on the screen says whose they are. */}
            {listing && !params.contactsOnly && (!params.mentionsOnly || !!folderOwnerName) && (
              <div className="uin-col-title">
                <h2>{viewTitle}</h2>
                <span className="uin-col-total">{headTotal}</span>
              </div>
            )}
            {/* Nothing above Drafts or Sent: where a conversation stands, and
                who it is assigned to, are questions about messages that have
                arrived. A message nobody has sent yet, or one already gone, has
                neither. */}
            {params.contactsOnly ? (
              <ContactsToolbar
                base={base}
                params={carried}
                view={params.contactsView}
                search={params.search}
                peopleCount={contactCount}
                organisationCount={organisationCount}
                canEdit={canEditLinks}
                canImport={canManage}
                categories={categoryList.map((c) => ({ id: c.id, name: c.name, people: c.peopleCount }))}
                categoryId={params.categoryId}
              />
            ) : params.mentionsOnly ? (
              /* The same four choices the conversation list has, narrowing the
                 same three states - the difference being whose they are. Only
                 the tabs: the other filters up here cut a list of post by who
                 sent it and when, and this is a list of jobs. */
              <StatusTabs
                base={base}
                params={carried}
                status={params.status}
                counts={askCounts}
                total={headTotal}
                unit="asked about"
                ariaLabel={folderOwnerName
                  ? `Where an ask stands with ${folderOwnerName}`
                  : 'Where an ask stands with you'}
              />
            ) : listing ? null : (
              <>
                <Filters
                  base={base}
                  params={carried}
                  unreadOnly={params.unreadOnly}
                  assignee={params.assignee}
                  search={params.search}
                  narrowed={{
                    from: params.fromText,
                    to: params.toText,
                    subject: params.subjectText,
                    withAttachment: params.withAttachment,
                    after: params.after,
                    before: params.before,
                  }}
                  staff={staff}
                  oldestFirst={params.oldestFirst}
                />
                <StatusTabs
                  base={base}
                  params={carried}
                  status={params.status}
                  counts={statuses}
                  total={headTotal}
                />
              </>
            )}
          </div>

          <div className="uin-col-scroll">{listView}</div>
        </div>

        {/* Always drawn, even with nothing in it. A right-hand half that appears
            and disappears is a screen that jumps every time somebody opens a
            row, and a mail program that shows a reading pane only once you have
            picked something is not one anybody recognises. */}
        <div className="uin-read">
          {otherPane ?? threadPane ?? (
            <div className="uin-nothing">
              {InboxIcon}
              <strong>Nothing open</strong>
              {params.contactsOnly
                ? 'Pick somebody from the list to see their card, everything they have written and everything the rest of the site knows about them.'
                : 'Pick something from the list to read it. Everything you can then do with it - answering it, setting it aside, handing it on - is at the top of it.'}
            </div>
          )}
        </div>

        {contextRail}

        {/* The two hairlines between the rail, the list and the conversation,
            made draggable. Last inside the frame so it is over the panes rather
            than under them, and drawn whatever is open: an edge that comes and
            goes with the reading pane is one nobody would trust to stay put. */}
        <ColumnResizer />
      </div>

      {/* Over the inbox rather than in place of it: starting a message is
          something somebody does while looking at the list, and the list is
          still there underneath when it closes. */}
      {composePane}
    </div>
  )
}

/** "1 conversation", "12 conversations". Here rather than inline because the
 *  head of the list column says it about four different things. */
function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n.toLocaleString('en-GB')} ${many}`
}

/** Reading the address book and writing in it are different grants, and a
 *  screen that offers a form somebody may not post is worse than one that says
 *  so. Only ever reached by typing the address in - the buttons that open these
 *  cards are not offered without the grant. */
function cannotWriteInTheBook() {
  return (
    <div className="uin-empty">
      <strong>You cannot add contacts</strong>
      You can read the address book, but adding to it needs the same permission as answering
      somebody. Whoever looks after the site can give you it.
    </div>
  )
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
