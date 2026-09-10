import Link from 'next/link'
import { headers } from 'next/headers'
import { after } from 'next/server'
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
  countDraftsByInboxOwner,
  countScheduledDrafts,
  categoriesForPeople,
  categoriesForPerson,
  countThreadsForPerson,
  countMentions,
  defaultInboxIdFor,
  railOrderFor,
  countThreads,
  draftForThread,
  draftsHeldByThread,
  getDraft,
  getDraftInInbox,
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
  listScheduledDrafts,
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
  openAssignedElsewhere,
  openCounts,
  wakeDueThreads,
  wakeDueMentions,
  type AttachmentRow,
  type MentionStatusFilter,
} from '@/modules/unified-inbox/lib/db'
import { countRunningCampaigns } from '@/modules/unified-inbox/lib/campaigns/store'
import { isSmsAvailable } from '@/lib/sms/send'
import { callerNumbers, firstDialler } from '@/lib/dialler/registry'
import { siteDiallingCode } from '@/lib/phone.server'
import { attachableKinds, loadContext, loadHints } from '@/modules/unified-inbox/lib/adapters'
import { defaultLinkKind } from '@/modules/unified-inbox/lib/link-kinds'
import { modulesForInbox } from '@/modules/unified-inbox/lib/module-senders'
import { forComposer } from '@/modules/unified-inbox/lib/drafts'
import { canAddProducts as canAddProductsFor, resolveProducts } from '@/modules/unified-inbox/lib/products'
import { publicRecordUrls } from '@/modules/unified-inbox/lib/record-urls'
import { addressesForPerson, buildContextQuery } from '@/modules/unified-inbox/lib/identity'
import { identityKey, isOwnSender, resolveOwnDomains } from '@/modules/unified-inbox/lib/people'
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
import { channelLabel, chooseSendingInbox, effectiveInboxParam, formatWhen, inboxHref, isSearching, NEW_CONTACT, parseInboxParams, PER_PAGE, shownCount, sortByChannelOrder } from '@/modules/unified-inbox/lib/list'
import { replyDestination, replyStyleFor } from '@/modules/unified-inbox/lib/channel-reply'
import { pushProviderRead } from '@/modules/unified-inbox/lib/provider-read'
import { providerForKey, visibleProviderChannels } from '@/modules/unified-inbox/lib/provider-registry'
import { InboxStyles } from './inbox/styles'
import { InboxIcon } from './inbox/icons'
import { NavRail } from './inbox/NavRail'
import { CampaignsPanel } from './inbox/campaigns/CampaignsPanel'
import { CampaignPulse } from './inbox/campaigns/CampaignPulse'
import { StatusTabs } from './inbox/StatusTabs'
import { SearchBar } from './inbox/SearchBar'
import { Filters } from './inbox/Filters'
import { ThreadListView } from './inbox/ThreadListView'
import { UndoProvider } from './inbox/UndoProvider'
import { NavProgress } from './inbox/NavProgress'
import { MentionListView } from './inbox/MentionListView'
import { DraftListView } from './inbox/DraftListView'
import { DraftReadView } from './inbox/DraftReadView'
import { SentListView } from './inbox/SentListView'
import { ThreadPane, type ThreadMessageView } from './inbox/ThreadPane'
import { spamOwnerFor, threadIsSpamFor } from '@/modules/unified-inbox/lib/spam'
import { isSenderBlocked } from '@/modules/unified-inbox/lib/blocked-senders'
import { normaliseAddress } from '@/modules/unified-inbox/lib/addresses'
import { ComposeView } from './inbox/ComposeView'
import { DiscussionView } from './inbox/DiscussionView'
import { SmsView } from './inbox/SmsView'
import { CallView } from './inbox/CallView'

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

  // EVERYTHING THIS SCREEN CAN ASK BEFORE IT KNOWS ANYTHING, ASKED AT ONCE.
  //
  // The panel is one server render and the database is at the other end of a
  // wire, so what decides how long a click takes is not how hard the queries
  // are - they are all indexed and none of them is slow - but how many times in
  // a row this function stops and waits. Written one `await` under another, the
  // block below was fourteen return trips nose to tail before a single row of
  // the list had been fetched, and every one of them was waiting on a question
  // that had nothing to do with the answer above it. The four grants, the site
  // clock, the folders, the settings, the channels, the colleague list: none of
  // them needs any of the others.
  //
  // So they go together and the wait is the slowest one rather than the sum of
  // all of them. Anything that genuinely does depend on something here waits in
  // the second round below, and the two snooze sweeps ride along in this one
  // because they must have finished before the counts are taken.
  //
  // The rule for adding to this list: it may go in the first round only if it
  // needs nothing from it. If it needs the folders, or who this person is
  // allowed to read, it belongs in the second.
  const [
    canView, canManage, canSendOut, canCampaign,
    timezone,
    allInboxes,
    settings,
    allChannels,
    ownInboxId,
    railOrder,
    staffRows,
    hubRolePermissions,
    draftTallies,
    connections,
    peopleTally,
    runningCampaigns,
  ] = await Promise.all([
    hasPermission(user, 'unifiedinbox.view'),
    hasPermission(user, 'unifiedinbox.manage'),
    // Whether this person may put anything OUT of the building at all - a
    // reply, a text, a call. Asked once and reused: it decides three different
    // things further down, and three copies of the same question is three
    // round trips.
    hasPermission(user, 'unifiedinbox.reply'),
    // Its own grant. Renaming a folder and emailing five thousand customers are
    // not the same act, and a site that gives somebody the first has not thereby
    // given them the second.
    hasPermission(user, 'unifiedinbox.campaigns'),
    // Read once and handed to every view below. This panel and everything under
    // it are server-rendered, so a clock time left to the machine's own zone
    // comes out in UTC - an hour behind the site for most of the year.
    getSiteTimezone(),
    listInboxes(),
    // The module's own settings, fetched once for the whole screen: which
    // channels the owner wants to see, whether to keep checking for mail while
    // somebody is watching, and which end a conversation opens at.
    getSettings(),
    // The channels another module owns - chat, enquiries, the phone. They sit
    // in no inbox and are not governed by the inbox guest lists: the module
    // that owns each one says who may read it, and this hub honours that answer.
    visibleProviderChannels(user),
    // The address this person calls their own, if it is still one they may
    // read. Resolved against the visible list below rather than trusted: an
    // address can be taken off somebody's guest list, or deleted, long after it
    // was made theirs, and a tab that opens on "that inbox is not here" is
    // worse than no tab.
    defaultInboxIdFor(user.id),
    // The order this person keeps the top of their own rail in. Theirs alone,
    // and saved without anybody's permission - see app/api/rail-order.
    railOrderFor(user.id),
    prisma.user.findMany({
      where: { suspendedAt: null },
      select: {
        id: true,
        displayName: true,
        username: true,
        // Only ever read to recognise a colleague's own address as one of ours -
        // it is never put on the page.
        email: true,
        roleId: true,
        role: { select: { isProtected: true } },
      },
      orderBy: { username: 'asc' },
    }),
    // Who can be ASKED to look at something, which is not everybody with an
    // account. A tag lands on somebody's own list inside this hub, so tagging a
    // colleague who has never been given the hub tells them nothing at all - and
    // a picker offering a name that quietly does nothing is worse than one that
    // does not offer it. One query for every role that holds the grant, rather
    // than one question per colleague.
    prisma.rolePermission.findMany({
      where: { permissionKey: { in: ['unifiedinbox.view', 'unifiedinbox.manage'] } },
      select: { roleId: true },
    }),
    // The number on this person's OWN Drafts tab: every draft they have written,
    // wherever it is filed, and nobody else's - the query says whose rather than
    // the caller (see lib/db.ts). The list itself is only fetched when that tab
    // is the one open.
    //
    // The per-address numbers are a different question with a different owner:
    // how much each COLLEAGUE has left half-written on their own address, for the
    // Drafts folder under their name (see countDraftsByInboxOwner). One grouped
    // query, because the rail is drawn on every list this hub renders.
    Promise.all([countDrafts(user.id), countDraftsByInboxOwner(), countScheduledDrafts(user.id)]),
    listConnections(),
    // Both counts in one query - one of them rides on the hub's own tab row, so
    // it is asked for on every render either way and there is no sense in two.
    peopleCount(),
    // Only whether anything is running at all, so the campaign clock is mounted
    // on a site that has a campaign on the go and left off every other one.
    countRunningCampaigns(),
    // Anything whose snooze has elapsed is open again by the time the list is
    // drawn. Doing it here rather than on a tick means a conversation is back
    // the moment somebody looks, which is the only moment it matters. The same
    // is true of something a colleague was asked to look at and put off until
    // Thursday, so the two sweeps run together - and both are finished before
    // the second round below takes any count that would otherwise miss them.
    wakeDueThreads(),
    wakeDueMentions(),
  ])
  const [draftCount, draftCounts, scheduledCount] = draftTallies
  const { people: contactCount, organisations: organisationCount } = peopleTally

  if (!canView) {
    return <div className="alert alert-danger">You do not have permission to read the inbox.</div>
  }

  const adminPath = (await headers()).get('x-cactus-admin-path') ?? ''
  const base = `/${adminPath}/inbox`
  const canEditLinks = canManage || canSendOut

  const visibleIds = await visibleInboxIds(user, allInboxes.map((i) => i.id))
  const visible = new Set(visibleIds)
  const inboxes = allInboxes.filter((i) => visible.has(i.id))

  // Minus the ones the owner has switched off in Settings. A site that points
  // every form at a real inbox does not want a Contact form entry listing the
  // same enquiries a second time. It is a decision about what is on the screen
  // and nothing else: the conversations are still collected, still opened by a
  // link and still governed by the same permissions, so switching a channel
  // back on brings back everything that arrived while it was off.
  const hiddenChannels = new Set(settings.hiddenChannelModules)
  // Two lists, deliberately. `allChannels` is what this site HAS and this
  // reader may see; `channels` is what goes in the rail. Hiding a channel is a
  // decision about the rail and nothing else, so anything asked about a
  // conversation already open - what it is called, whether it can be answered -
  // is asked of the full list. Conflating the two told somebody whose form
  // posts into a real inbox that the contact form was no longer installed, on a
  // site that was running it perfectly well.
  //
  // In the order the site has dragged them into, which is a decision about the
  // rail in exactly the way hiding one is - so it is applied here, to the list
  // that goes on the screen, and `allChannels` stays the full list anything
  // asked about an open conversation is asked of.
  const channels = sortByChannelOrder(
    allChannels.filter((channel) => !hiddenChannels.has(channel.key)),
    settings.channelOrder,
  )
  const channelModules = channels.map((c) => c.key)

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

  // Falling back to an address that IS theirs, when nobody has pinned one.
  // Saving an individual inbox writes its owner a default row (see
  // audienceForSave), so this is usually the same answer twice - but an address
  // made somebody's before that was true, or a pin cleared since, would leave
  // them landing on All every morning while their own post sat one click away.
  // Opening the hub takes somebody to their own inbox, full stop.
  const ownedInboxId = inboxes.find(
    (i) => i.kind === 'individual' && i.ownerUserId === user.id,
  )?.id ?? null
  const pinnedInboxId = (ownInboxId && visible.has(ownInboxId) ? ownInboxId : null) ?? ownedInboxId

  // An address of one's own is where the hub opens when the URL names no tab,
  // so it is settled here, before anything is parsed - every query, count and
  // link below is then built from the one answer rather than from two.
  const wantedInbox = effectiveInboxParam(searchParams.inbox, pinnedInboxId)
  const chosen = wantedInbox ? { ...searchParams, inbox: wantedInbox } : searchParams
  const params = parseInboxParams(chosen)

  // Whether the queue - the open conversations nobody has picked up - is a
  // question worth asking of this list at all.
  //
  // Only on a shared address somebody is actually standing in. Not on an
  // individual one, where every conversation is on the desk of whoever owns it
  // by definition; not on All or a channel, where "has anybody taken this"
  // would span half a dozen addresses with no one team behind them; and not on
  // the mail that landed nowhere, which nobody can be handed in the first
  // place. Read off the inboxes this reader may open rather than off the id in
  // the address, so an id they are not on cannot conjure the tab.
  const sharedInbox = !!params.inboxId
    && inboxes.some((i) => i.id === params.inboxId && i.kind === 'shared')
  // And what the list is therefore narrowed to. A hand-typed ?status=unassigned
  // on a list with no queue tab over it would be a filter nobody could see and
  // nobody could take off, which is the one thing every cut on this screen is
  // built to avoid - so it falls back to Open, exactly as an unknown status
  // already does (see parseInboxParams).
  const status = params.status === 'unassigned' && !sharedInbox ? 'open' : params.status

  // The tab has to survive every link on this screen, or following one lands on
  // whichever tab the host happens to render first.
  const carried: Record<string, string> = { tab: 'unified-inbox' }
  for (const key of [
    'inbox', 'status', 'unread', 'assignee', 'q', 'sort', 'page', 'id', 'person',
    // The search dialog's narrower cuts, so a search survives opening one of
    // the conversations it found and coming back to the list.
    'from', 'to', 'subject', 'att', 'after', 'before',
    // And whether those cuts are a search's own screen or a list somebody
    // narrowed where it stood, so opening one of the results and coming back
    // lands on the search rather than on a list with no head to it.
    'find',
    // The address book's own: which half of it, whose card is open, whether the
    // card is being edited, and whether the importer is up.
    'view', 'org', 'edit', 'import', 'cat',
    // Which campaign is open, and which of its four steps.
    'campaign',
  ] as const) {
    const value = chosen[key]
    if (value) carried[key] = value
  }
  // Except a queue asked for where there is no queue: settled above, so it is
  // settled here too rather than riding along on every link on the screen as a
  // word the panel has already decided to ignore.
  if (carried.status === 'unassigned' && !sharedInbox) delete carried.status

  const staff = staffRows.map((s) => ({ id: s.id, name: s.displayName || s.username }))
  const staffById = Object.fromEntries(staff.map((s) => [s.id, s.name]))

  const hubRoleIds = new Set(hubRolePermissions.map((row) => row.roleId))
  const taggable = staffRows
    .filter((person) => person.role.isProtected || hubRoleIds.has(person.roleId))
    .map((person) => ({ id: person.id, name: person.displayName || person.username }))

  // THE SECOND ROUND. Everything that needed to know which folders this person
  // may read, and which channels are on their rail, and could therefore not go
  // in the first - and, like the first, nothing here needs anything else here.
  // Five numbers for the rail, the sendable addresses and the two cheap "can
  // this site do it at all" questions, in one wait rather than seven.
  const [
    counts,
    assignedElsewhere,
    askedCount,
    spamCount,
    sendableIds,
    smsAndDialler,
  ] = await Promise.all([
    openCounts(user.id, visibleIds, canManage, channelModules),
    // What has been handed to whoever is reading and is filed somewhere other
    // than their own address. It goes onto their own address's number, because
    // standing in that address is now where they read it - there is no
    // "Assigned to me" screen to go and look at, and having to remember to look
    // at one was the whole complaint.
    pinnedInboxId
      ? openAssignedElsewhere(user.id, visibleIds, canManage, channelModules, pinnedInboxId)
      : Promise.resolve(0),
    // What colleagues have asked this person to look at and they have not dealt
    // with yet. One cheap COUNT on every draw, because it rides on the rail; the
    // list itself is only fetched when that is the tab open, the same as Drafts,
    // Sent and Contacts.
    openMentionCount(user.id),
    // What this person has thrown away, for the number beside the folder. Theirs
    // alone: junk is one reader's opinion rather than a fact about the mail (see
    // lib/spam.ts), so unlike every other count on this rail there is no version
    // of it that belongs to an address or to the team.
    //
    // UNREAD junk only, like every other number on this rail. It counted the
    // whole folder once, on the reasoning that "how much is in there" is the
    // question a spam folder answers - but a bin nobody empties fills up, and a
    // permanent 47 beside a folder is a number that has stopped meaning anything.
    // A number that appears when something new has been thrown away and goes back
    // to nothing when it has been looked at is one worth reading.
    //
    // Status 'all' still: junk that was already marked done is still junk that
    // arrived, and a folder ignoring its own contents because of a tab that is no
    // longer drawn above it would be a folder saying nothing while holding
    // something.
    //
    // Through countThreads rather than a tally of its own, so it carries the same
    // visibility clause the folder's own list carries: what this reader may open,
    // which channels they may see, whether unfiled post is theirs. A count that
    // worked it out separately would drift, and a folder saying 4 with three
    // things in it is the one place that matters - somebody would go looking for
    // a message they had thrown away and could not find.
    countThreads({
      viewerUserId: user.id,
      spamOnly: true,
      // Their own, explicitly. The number under Yours counts your bin; a
      // colleague's folder carries its own total in the head of the list.
      spamOwnerUserId: user.id,
      inboxIds: visibleIds,
      includeUnrouted: canManage,
      providerModules: channelModules,
      status: 'all',
      unreadOnly: true,
      page: 1,
      perPage: PER_PAGE,
    }),
    // Writing a new one is a different grant from reading (D16), so the From
    // menu and the button that opens it are both built from the inboxes this
    // person may SEND from. No sendable address means no button: an invitation
    // to write that ends in "you do not have permission to send from that
    // inbox" is worse than no invitation.
    replyableInboxIds(user, inboxes.map((i) => i.id)),
    // The two other things the compose button can start, narrowed to the ones
    // this site can actually do. Both questions are asked the CHEAP way here -
    // is there a module that sends texts, is there a module that places calls -
    // rather than by reaching a telephony API to ask whether it is configured,
    // because this runs on every draw of every list. The expensive question is
    // asked by the screen that opens, where somebody is waiting for an answer
    // anyway.
    canSendOut
      ? Promise.all([isSmsAvailable(), firstDialler(user)])
      : Promise.resolve([false, null] as const),
  ])

  // Before the desk is added below: All is the sum of the addresses, and a
  // conversation counted twice would make it larger than the list it stands for.
  const allOpen = Object.values(counts).reduce((a, b) => a + b, 0)
  const [smsReady, dialler] = smsAndDialler
  const sendable = inboxes.filter((i) => sendableIds.includes(i.id))
  const composeHref = sendable.length > 0
    ? inboxHref(base, carried, { compose: '1', draft: null, id: null, person: null })
    : null

  // The three other things the button can start, narrowed to the ones this site
  // can actually do - the two paid-for ones settled in the round above.
  //
  // A discussion needs nothing switched on: it is an internal note, and this
  // module has always been able to write one. It does need somewhere to put it,
  // which on a site where this person can read nothing is nowhere.
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

  // Whose half-written writing this list holds. The tab under Yours is this
  // person's own, wherever it is filed. A folder under a colleague's NAME is
  // theirs, narrowed to their own address - the same shape the Mentioned and
  // Spam folders beside it already take, and settled here from the address the
  // rail asked for rather than from anything in the query string (E17).
  //
  // "Own" also covers a reader who has hand-typed the folder for their OWN
  // address. The rail never links there - their own inbox sits under Yours and
  // opens no folders - but landing on a read-only view of your own half-written
  // reply would be a screen refusing to let you finish something nobody is
  // stopping you finishing.
  //
  // A null owner is an address with nobody behind it, or one this reader may not
  // open. That draws an empty folder rather than quietly falling back to their
  // own drafts under somebody else's name.
  const draftsAreOwn = !folderAsked || folderOwnerId === user.id
  const draftOwnerId = draftsAreOwn ? user.id : folderOwnerId
  const drafts = params.draftsOnly && draftOwnerId
    ? await listDrafts(draftOwnerId, folderAsked ? folderIds : null)
    : []
  // The other half of the same table: what has a time on it and has not gone
  // yet. Its own folder rather than a tag in the list above, because the two
  // answer different questions - what have I not finished, and what is going
  // out without me. Fetched only when that is the list being looked at; the
  // number beside it is wanted on every screen, which is why the count above
  // is not conditional.
  const scheduled = params.scheduledOnly
    ? await listScheduledDrafts(user.id, folderAsked ? folderIds : null)
    : []

  // What has been sent. Two different lists behind one word, and which one this
  // is turns on whether an address was named.
  //
  // No address is the entry under Yours, and it is a PERSON's folder: this
  // reader's own writing, from their own address and from every shared one they
  // write from, and nobody else's. It used to be every message that had left
  // every address they could read, which on a site with a shared sales@ meant
  // opening your own Sent folder and finding your colleagues' post in it.
  //
  // An address named is that ADDRESS's folder - the one hanging under it on the
  // rail - and there it is everything that has left, whoever wrote it and
  // including whatever a module sent on its own. That is what somebody opens it
  // to see: "has that quote gone out from sales@".
  //
  // Only fetched when that is the list being looked at.
  const sentOwnerId = folderAsked ? null : user.id
  const [sent, sentTotal] = params.sentOnly
    ? await Promise.all([
        listSentMessages(folderIds, !folderAsked && canManage, folderAsked ? [] : channelModules, params.page, PER_PAGE, sentOwnerId),
        countSentMessages(folderIds, !folderAsked && canManage, folderAsked ? [] : channelModules, sentOwnerId),
      ])
    : [[] as Awaited<ReturnType<typeof listSentMessages>>, 0]

  // Everything colleagues have asked this person about, when that is the list
  // being looked at. Scoped to them in the SQL rather than after it, like every
  // other list on this screen (E17) - this table is the one place that knows a
  // colleague was let into a conversation their inbox guest list does not
  // cover, and a row of it belongs to exactly one person.
  // The queue is a question about a shared ADDRESS, and an ask belongs to one
  // named person by definition - so the tab is never drawn over this list, and
  // a hand-typed ?status=unassigned lands on Open rather than on a filter this
  // table cannot answer.
  const askStatus: MentionStatusFilter = status === 'unassigned' ? 'open' : status
  const [asks, askTotal, askCounts] = params.mentionsOnly && folderOwnerId
    ? await Promise.all([
        listMentions({
          userId: folderOwnerId,
          status: askStatus,
          page: params.page,
          perPage: PER_PAGE,
          inboxId: folderInbox?.id ?? null,
        }),
        countMentions(folderOwnerId, askStatus, folderInbox?.id ?? null),
        mentionStatusCounts(folderOwnerId, folderInbox?.id ?? null),
      ])
    : [[] as Awaited<ReturnType<typeof listMentions>>, 0, {} as Record<string, number>]

  const filters = {
    viewerUserId: user.id,
    spamOnly: params.spamOnly,
    // WHOSE bin. Their own under Yours; a colleague's under that colleague's
    // name, because junk filed in somebody's own address goes into THEIR bin
    // (see spamOwnerFor) and a coverer who binned something by mistake has to
    // be able to go and get it back.
    //
    // Null - not undefined - when the scope names an address with no owner, or
    // one this reader may not open. That draws an empty folder rather than
    // quietly falling back to their own junk under somebody else's name.
    spamOwnerUserId: params.spamOnly ? folderOwnerId : undefined,
    inboxIds: visibleIds,
    includeUnrouted: canManage,
    providerModules: channelModules,
    inboxId: params.inboxId,
    // Standing in their own address means standing in front of everything on
    // their desk, wherever it was filed. There is no "Assigned to me" screen to
    // go and look at any more, and there should not be: work handed to somebody
    // belongs where they already are.
    alsoAssignedTo: pinnedInboxId && params.inboxId === pinnedInboxId ? user.id : null,
    providerModule: params.providerModule,
    unroutedOnly: params.unroutedOnly,
    // Everything in the bin, whatever state it was in when it went there. The
    // Spam folder draws no status tabs (see below), and a folder filtered by a
    // choice it does not offer is a folder that hides things for no reason
    // anybody can see: junk marked done before it was junked would simply not
    // be there, under a default nobody picked.
    status: params.spamOnly ? 'all' : status,
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
    // The conversation list grows rather than turning pages: what the address
    // calls page 3 is the newest seventy-five in one list, not the third
    // twenty-five on their own. So it is always the first page of a bigger
    // helping - see shownCount, and the foot of ThreadListView for the button
    // that asks for the next one.
    page: 1,
    perPage: shownCount(params.page),
  }

  // The status tabs count what is behind them given everything else already
  // chosen, so they come from the same filters with the status left out.
  const listing = params.draftsOnly || params.scheduledOnly || params.sentOnly || params.contactsOnly
    || params.campaignsOnly || params.mentionsOnly
  // Open, Snoozed, Done and All are questions about work in hand. Nothing in
  // the bin is work in hand: junk is not answered, not set aside until Monday
  // and not finished, so the row of tabs above it offered four ways to look at
  // one pile. Gone there, and the query that fills them is not run either.
  const showStatusTabs = !listing && !params.spamOnly
  const showUnassigned = showStatusTabs && sharedInbox
  const [rows, total, statuses] = listing
    ? [[] as Awaited<ReturnType<typeof listThreads>>, 0, {} as Record<string, number>]
    : await Promise.all([
        listThreads(filters),
        countThreads(filters),
        showStatusTabs ? statusCounts(filters) : Promise.resolve({} as Record<string, number>),
      ])
  // "Nothing has been collected yet" is a story about collecting mail, so it is
  // only told where collecting mail is what fills the list. A site whose
  // channels are a live chat and an enquiry form has no mail connection to have
  // run, and was being told its inbox had never collected anything - which is
  // true, and beside the point, and points at a screen most readers cannot open.
  // When the post last arrived, for the line at the foot of the rail. The
  // newest of the accounts rather than each of them: "Updated" is a fact about
  // the screen somebody is looking at, not about one mailbox. Milliseconds
  // rather than a Date, because this crosses into a client component and a
  // plain number cannot be mangled on the way.
  const lastCheckedAt = connections.reduce<number | null>((newest, c) => {
    if (!c.lastSyncAt) return newest
    const at = c.lastSyncAt.getTime()
    return newest === null || at > newest ? at : newest
  }, null)

  const neverSynced = !params.providerModule
    && inboxes.length > 0
    && (connections.length === 0 || connections.every((c) => !c.lastSyncAt))

  // ---- the address book -------------------------------------------------
  //
  // The count rides on the tab row and is asked for on every render, which is
  // one cheap COUNT; the lists themselves are only fetched when the Contacts tab
  // is the one open, the same as Drafts and Sent above.
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
      //
      // Beside it, where the attached records that have a customer-facing page
      // actually live - the products - because a product is attached to
      // somebody because it was quoted to them.
      const [outbound, publicUrls] = await Promise.all([
        outboundLogForAddresses(addresses),
        publicRecordUrls(links),
      ])

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
          publicUrls={publicUrls}
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
      if (thread.unread) {
        await setThreadRead(thread.id, false)
        // And the channel that owns it is told, so the next collection does not
        // arrive still calling it new and mark it unread all over again.
        //
        // AFTER the reply has gone out, not before it. Telling a channel is a
        // call to somebody else's server - Chatwoot's, on a chat - and awaiting
        // it here put a whole network round trip, to a machine this site does
        // not own, between somebody clicking a conversation and seeing it. Which
        // was a strange price to pay for a housekeeping note nobody is waiting
        // on: the conversation is already read as far as this site is concerned,
        // written down one line above, and the pane does not read the answer.
        // A channel that is slow, or down, now costs the reader nothing.
        after(() => pushProviderRead(thread))
      }

      const [messages, files, events, ownDraft, heldDrafts, sellsAnything] = await Promise.all([
        listThreadMessages(thread.id),
        attachmentsForThread(thread.id),
        listThreadEvents(thread.id),
        draftForThread(thread.id, user.id),
        // Anything of this person's own that was queued and stood down when
        // this arrived. Scoped to them like every other way of reaching a
        // draft, so the warning is not a way of learning that a colleague had
        // one waiting.
        draftsHeldByThread(thread.id, user.id),
        // Whether there is a catalogue on this site at all, and whether this
        // person may see it. Asked here rather than in the box, because it is a
        // permission and the box is in a browser.
        canAddProductsFor(user),
      ])
      // What the half-written reply was carrying out of that catalogue, as it
      // stands today. The draft stores only which - a name and a price a week
      // old are a name and a price worth reading again.
      const draftProducts = ownDraft && ownDraft.products.length > 0
        ? (await resolveProducts(ownDraft.products)).map((p) => p.choice)
        : []
      const byMessage = new Map<string, AttachmentRow[]>()
      for (const file of files) {
        const list = byMessage.get(file.messageId)
        if (list) list.push(file)
        else byMessage.set(file.messageId, [file])
      }
      // Which of these messages came from us. Built here from what this page
      // already holds - the addresses, the colleagues and the settings are all
      // loaded above - rather than asked per message, so recognising our own
      // post costs no query at all. See isOwnSender for why it decides whether
      // the pictures are held back.
      const ownSenderGate = {
        ownAddresses: new Set(
          allInboxes.map((i) => identityKey(i.address)).filter((a): a is string => !!a),
        ),
        staffAddresses: new Set(
          staffRows.map((s) => identityKey(s.email)).filter((a): a is string => !!a),
        ),
        ownDomains: resolveOwnDomains(
          allInboxes.map((i) => i.address),
          settings.ownDomains,
          settings.personalDomains,
        ),
      }
      const view: ThreadMessageView[] = messages.map((m) => ({
        ...m,
        attachments: byMessage.get(m.id) ?? [],
        ownSender: isOwnSender(m, ownSenderGate),
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

      // The full list, not the rail's: a channel switched off the rail is still
      // installed, still collecting and still answerable.
      const channel = thread.providerModule
        ? allChannels.find((c) => c.key === thread.providerModule) ?? null
        : null
      // A discussion has nobody outside it to answer, so there is nothing to
      // send and no Reply to offer. What is left is the note box, which is what
      // a discussion is made of anyway - so the composer arrives on the one mode
      // that applies rather than on a Reply that would refuse.
      const isDiscussion = thread.channel === 'discussion'
      // canSendOut rather than a fresh hasPermission: it is the same grant, and
      // round one already holds the answer. Asking again here, and twice more
      // below, was three extra round trips for anybody who is not an admin -
      // exactly the waste the note beside canSendOut warns about.
      const canReplyHere = isDiscussion
        ? Promise.resolve(false)
        : thread.providerModule
          ? Promise.resolve((channel?.canReply ?? false) && canSendOut)
          : thread.inboxId
            ? canReplyToInbox(user, thread.inboxId)
            : Promise.resolve(false)
      // Deleting takes the same two halves as replying: the channel has to offer
      // it, and this reader has to be allowed on that channel. Note it is the
      // channel's OWN permission that was already checked to build `channels`,
      // so a channel this person cannot see never gets this far.
      const canDeleteMessages = thread.providerModule ? (channel?.canDelete ?? false) : false

      // Blocking asks the channel who it is dealing with, which is a round trip
      // to somebody else's server, so it is only asked where the channel can
      // actually refuse somebody and this reader may act on it - and it is
      // asked ALONGSIDE everything else this pane needs rather than in front of
      // it, because a slow channel was holding up the whole conversation.
      const blockStateAsked = (async (): Promise<{ blocked: boolean; channelLabel: string } | null> => {
        if (!thread.providerModule || !channel?.canBlock || !canSendOut) return null
        const resolved = await providerForKey(thread.providerModule)
        const askBlocked = resolved?.provider.isParticipantBlocked
        if (!askBlocked || !thread.externalId) return null
        try {
          return { blocked: await askBlocked(thread.externalId), channelLabel: channel.label }
        } catch {
          // A channel that cannot say is not a reason to take the conversation
          // off somebody. Offer the block and let the press be the answer.
          return { blocked: false, channelLabel: channel.label }
        }
      })()

      // Junk, as this reader sees it, and whether the sender is already refused.
      //
      // Two questions rather than one because they have two different scopes:
      // the first is a row belonging to this person, the second is a fact about
      // the whole site. Asked together because the button in the header needs
      // both before it can decide whether there is a second question worth
      // putting to anybody.
      //
      // The address comes off the newest message THEY sent us, and inbound is
      // the whole of that clause. `newest` - the one the reply arrow answers -
      // is our own writing on every conversation a colleague has already
      // replied to, and reading a sender off it would offer to block one of the
      // site's own addresses on exactly the conversations somebody is most
      // likely to be tidying up.
      //
      // `replyTo` beats `from` for the same reason it does everywhere else in
      // this module (E13): a sender who nominated a Reply-To is telling us which
      // of the two addresses is actually theirs, and it is the one a reply would
      // have gone to.
      const lastInbound = [...messages].reverse().find((m) => m.direction === 'in') ?? null
      const spamSender = lastInbound
        ? normaliseAddress(lastInbound.replyTo || lastInbound.fromAddress || '')
        : ''
      const senderAddress = spamSender.includes('@') ? spamSender : null
      // Whose bin this one would go into, worked out the same way the route
      // works it out - a conversation in a colleague's own address is theirs,
      // and somebody covering it is clearing THEIR bin rather than filling
      // their own. Asked here as well so the button offers the right one of the
      // two: a conversation Sam has already binned reads "Not junk" to whoever
      // is covering Sam, and can be put back.
      const spamOwnerId = spamOwnerFor({
        pressedByUserId: user.id,
        inbox: thread.inboxId
          ? allInboxes.find((i) => i.id === thread.inboxId) ?? null
          : null,
      })
      //
      // EVERYTHING LEFT THAT THIS PANE NEEDS, IN ONE WAIT.
      //
      // Whether this reader may answer, what the channel says about the sender,
      // whose junk this is, what a colleague asked, and the records attached to
      // it. Five separate waits once, one after another, and not one of them
      // needed an answer from any of the others - so opening a conversation
      // spent five return trips settling questions that could all have been
      // asked at the same moment. The one genuine dependency is further down:
      // the hints and the public links are asked of what comes back here.
      const [
        canReply, blockState, isSpam, senderBlocked, ask,
        links, kindOptions, senderModules, merges, contextQuery,
      ] = await Promise.all([
        canReplyHere,
        blockStateAsked,
        threadIsSpamFor(thread.id, spamOwnerId),
        senderAddress ? isSenderBlocked(senderAddress) : Promise.resolve(false),
        // This reader's own ask on this conversation, when a colleague put
        // their name on it. Nobody else's: what somebody was asked and whether
        // they have got to it is between them and whoever asked them.
        mentionForThread(user.id, thread.id),
        linksForThread(thread.id),
        canEditLinks ? attachableKinds(user) : Promise.resolve([]),
        canEditLinks && thread.inboxId ? modulesForInbox(thread.inboxId) : Promise.resolve([]),
        // Only asked for when there is somebody who could act on the answer.
        canManage ? undoableThreadMerges(thread.id) : Promise.resolve([]),
        // Who we are dealing with, in the form the adapters match on. Only
        // worth building once the conversation has been matched to somebody -
        // a first message from a stranger has nobody to look up.
        thread.personId ? buildContextQuery(thread.personId) : Promise.resolve(null),
      ])

      // HOW this one is answered, as against whether it may be. An email is
      // addressed by typing an address and may carry markup and files; a
      // conversation another module owns is handed to that module as one
      // string and goes back where it came from, so there is nothing to
      // address and nothing to attach. Drawing the email box on one of those
      // is what stopped every WhatsApp message being answered at all: the To
      // line came back empty, because a WhatsApp conversation has a number on
      // it and no address anywhere, and an empty To line disables Send.
      const style = replyStyleFor(thread, channel?.textStyles)
      const destinationLine = style.addressed
        ? null
        : replyDestination({
          // The channel's own word for itself where we have it, falling back to
          // the name this module keeps for the channel the conversation is
          // filed under - a channel whose module has gone still says what it
          // was.
          channelLabel: channel?.label ?? channelLabel(thread.channel),
          // What the far end is keyed on. `external_id` is the conversation's
          // identity to the module that owns it, which for the telephony
          // channels is the other person's number - the same thing a reply is
          // actually sent to.
          party: lastInbound?.fromPhone ?? lastInbound?.fromAddress ?? thread.externalId,
          name: lastInbound?.fromName ?? null,
        })

      const cannotReplyReason = canReply
        ? null
        // A DISCUSSION SAYS NOTHING. The sentence that used to sit here
        // explained the missing reply arrow, and on a discussion there is
        // nothing to explain: the channel is named at the top, every message on
        // it is marked as a note, and the line at the foot says on its face that
        // nobody outside sees it. Three places already say it; a fourth, in the
        // spot a conversation uses to report a problem, read as one.
        : isDiscussion
        ? null
        : thread.providerModule
          ? channel
            ? `${channel.label} conversations are read here and answered where they came from.`
            // No channel at all means the module that ran it has been removed,
            // which by now is the only way to get here and is rare enough that
            // a notice about it was doing more harm than good. The conversation
            // stays readable (E20) and says nothing further.
            : null
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

      //
      // What may be attached by hand is a separate question from what is here
      // already: the kinds are whichever record-keeping modules this viewer may
      // see, and which one the picker opens on comes from what the inbox is
      // used for. An address purchasing sends from is an address suppliers
      // answer purchase orders at, and that is worth one less choice made by
      // hand on every conversation in it.

      // What the rest of the site already knows about them: "Existing
      // customer", and nothing longer. Asked after the records rather than
      // beside them because the records decide which of these are worth asking
      // for at all - a hint the attached order already answers costs no query.
      //
      // With it, where the attached records that have a customer-facing page
      // actually live. A product is on a conversation because somebody quoted
      // it, so its name on this line opens the page the customer was sent
      // rather than the editor behind it.
      const [hints, publicUrls] = await Promise.all([
        contextQuery ? loadHints(user, contextQuery, links) : Promise.resolve([]),
        publicRecordUrls(links),
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
          /* Only the id and what it was called: who did it and when are the
             log's own words, and the log is where the way out of a merge lives
             now. */
          merges={merges.map((merge) => ({ id: merge.id, subject: merge.loserSubject }))}
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
          style={style}
          destinationLine={destinationLine}
          replyTo={[...reply.to, ...reply.cc]}
          replyAllTo={[...replyAll.to, ...replyAll.cc]}
          replySubject={replySubjectLine}
          forwardSubject={forwardSubjectLine}
          draft={ownDraft ? forComposer(ownDraft) : null}
          canAddProducts={sellsAnything}
          draftProducts={draftProducts}
          newestFirst={settings.newestFirst}
          scrollToMessageId={openOnMessage?.id ?? null}
          showAvatars={settings.showAvatars}
          canDeleteMessages={canDeleteMessages}
          blockState={blockState}
          spamState={{
            spam: isSpam,
            /* Whose bin, said out loud when it is not the reader's own.
               "Moved to Sam's spam" and "Moved to your spam" are different
               sentences, and somebody covering a colleague's post deserves the
               one that is true. Null on their own post and on every shared
               address, where the button means exactly what it looks like. */
            ownerName: spamOwnerId === user.id ? null : staffById[spamOwnerId] ?? null,
            senderAddress,
            senderBlocked,
            /* Blocking changes what everybody on the site receives, so it takes
               the grant for acting on the outside world rather than the one for
               reading it - the same line the channel block next door draws. */
            canBlock: canSendOut,
          }}
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
            sourceLabel: thread.sourceLabel,
            hints,
            links,
            publicUrls,
            canEditLinks,
            linkKinds: kindOptions,
            defaultLinkKind: defaultLinkKind(kindOptions, senderModules),
          }}
        />
      )

    }
  }

  // ---- a colleague's draft, opened to be read -----------------------------
  //
  // Only ever reached from the Drafts folder under somebody's name, and never
  // opened to be WRITTEN in: the row links here with `?draft=` and nothing
  // else, so the composing branch below is not entered and there is no writing
  // box on the screen to be refused afterwards. What the pane does offer, to
  // somebody who may send from that address, is a button that posts it exactly
  // as it stands - see canSendDraftForOwner in lib/drafts.ts.
  //
  // Both halves of the question go to the database (E17): whose draft, and
  // which address it is filed on. `folderInbox` has already been resolved
  // against the addresses this reader may open, so an id typed into the address
  // bar for an address they may not see finds nothing at all.
  let draftReadPane: React.ReactNode = null
  if (params.draftsOnly && !draftsAreOwn && params.draftId && folderInbox && folderOwnerId) {
    const reading = await getDraftInInbox(params.draftId, folderOwnerId, folderInbox.id)
    draftReadPane = reading ? (
      <DraftReadView
        base={base}
        params={carried}
        draft={reading}
        ownerName={folderOwnerName ?? folderInbox.name}
        inboxName={folderInbox.name}
        inboxId={folderInbox.id}
        // Whether they may send it out for its author, which is exactly whether
        // they may send from that address at all (D16) - the same list the
        // compose button is built from. Reading somebody's post is not sending
        // as them, so a coverer let in to read and no more gets the read-only
        // sentence they always got.
        canSend={sendableIds.includes(folderInbox.id)}
        now={new Date()}
        timezone={timezone}
      />
    ) : (
      <div className="uin-empty">
        <strong>That draft is not here any more</strong>
        It has been sent, thrown away, or moved to another address since this list was drawn.{' '}
        <Link href={inboxHref(base, carried, { draft: null })}>Back to the folder</Link>
      </div>
    )
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
      // Where it goes is settled here rather than asked: the address this
      // person calls their own, which is the answer nine times in ten and the
      // only one a site with personal inboxes wants. Failing that - nobody has
      // been given an address of their own - the tab they are standing in, and
      // failing that the first address they may read at all. Reading rights,
      // not sending ones: a discussion is a note, and a note goes nowhere.
      const standingIn = params.inboxId && visible.has(params.inboxId) ? params.inboxId : null
      const discussionInboxId = pinnedInboxId ?? standingIn ?? inboxes[0]?.id ?? null

      composePane = discussionInboxId ? (
        <DiscussionView
          base={base}
          params={carried}
          inboxId={discussionInboxId}
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
      // The site's dialling code, so a number typed the way people type one -
      // 07700 900123 - reads as a whole number here, exactly as it does on the
      // call form. Core's setting, not a constant of this module's.
      const diallingCode = smsReady ? await siteDiallingCode() : ''
      composePane = smsReady ? (
        <SmsView base={base} params={carried} defaultTo={knownPhone} diallingCode={diallingCode} />
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
    // Only ever this person's own, and the query is what decides it rather than
    // a check afterwards, so a colleague's id typed into the address bar finds
    // nothing at all rather than something to be refused.
    const editing = params.draftId ? await getDraft(params.draftId, user.id) : null
    if (sendable.length > 0) {
      composePane = (
        <ComposeView
          base={base}
          params={carried}
          inboxes={sendable.map((i) => ({ id: i.id, name: i.name, address: i.address }))}
          defaultInboxId={chooseSendingInbox(sendableIds, editing?.inboxId ?? params.inboxId)}
          draft={editing ? forComposer(editing) : null}
          canAddProducts={await canAddProductsFor(user)}
          draftProducts={editing && editing.products.length > 0
            ? (await resolveProducts(editing.products)).map((p) => p.choice)
            : []}
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

  // What this render IS, as one string, for the "we heard you" bar to measure
  // against - see NavProgress. Built from the address the panel actually drew
  // rather than from the address bar, because those two are only the same once
  // the navigation has finished, which is precisely the thing being reported.
  const routeKey = JSON.stringify(carried)

  // A folder under a colleague's name says which folder AND whose, in one
  // value, because the rail highlights one entry and there are three of them
  // under every colleague.
  const folderTab = params.draftsOnly ? 'drafts' : params.sentOnly ? 'sent' : params.spamOnly ? 'spam' : 'mentions'
  const currentTab = params.folderInboxId
    ? `${folderTab}:${params.folderInboxId}`
    : params.draftsOnly
    ? 'drafts'
    : params.scheduledOnly
    ? 'scheduled'
    : params.sentOnly
      ? 'sent'
      : params.contactsOnly
        ? 'contacts'
        : params.campaignsOnly
          ? 'campaigns'
          : params.spamOnly
          ? 'spam'
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
    ? channels.find((c) => c.key === params.providerModule) ?? null
    : null
  // Whose folder it is, said in front of which folder it is: "Sam Blake ·
  // Sent". The name first because on this screen the surprising half is whose
  // post you are looking at, not that it is the sent one.
  const folderPrefix = folderOwnerName ? `${folderOwnerName} \u00b7 ` : ''
  const viewTitle = params.draftsOnly
    // The colleague's name in front of it when it is theirs, exactly as the
    // three folders beside it - "Sam Blake · Drafts" - because on this screen
    // the surprising half is whose unfinished writing you are reading. No name
    // at all on the tab under Yours, which is your own.
    ? `${draftsAreOwn ? '' : folderPrefix}Drafts`
    // Nobody's name in front of this one: a message set to go out belongs to
    // whoever wrote it, wherever it leaves from, and there is no version of the
    // folder under somebody else's name to need one.
    : params.scheduledOnly
    ? 'Scheduled'
    : params.sentOnly
      ? `${folderPrefix}Sent`
      : params.contactsOnly
        ? (showingOrganisations ? 'Organisations' : 'Contacts')
        : params.spamOnly
          ? `${folderPrefix}Spam`
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
    : params.scheduledOnly
    ? plural(scheduled.length, 'message', 'messages')
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
  //
  // The campaign clock rides with it. It renders nothing and its only job is to
  // keep a running campaign moving at the pace it was set to rather than the
  // pace of the site's scheduled round - so it belongs on every inbox screen,
  // not on the one screen nobody has any reason to sit and watch. Mounted only
  // where there is something for it to do: somebody allowed to send campaigns,
  // and a campaign actually running.
  const rail = (
    <>
      {canCampaign && runningCampaigns > 0 && <CampaignPulse />}
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
        count: (counts[i.id] ?? 0) + (i.id === pinnedInboxId ? assignedElsewhere : 0),
      }))}
      channels={channels.map((c) => ({
        key: c.key,
        label: c.label,
        count: counts[`m:${c.key}`] ?? 0,
      }))}
      allCount={allOpen}
      current={currentTab}
      me={{ id: user.id, name: staffById[user.id] ?? 'You' }}
      showAvatars={settings.showAvatars}
      askedCount={askedCount}
      railOrder={railOrder}
      showUnrouted={canManage}
      unroutedCount={counts[''] ?? 0}
      /* Only where there is something in it. An empty Drafts folder is a row
         that can only ever disappoint, so it stays away until somebody puts a
         message down half-written - and stays put while they are standing in
         it, so deleting the last one does not pull the list out from under the
         person reading it. */
      showDrafts={draftCount > 0 || currentTab === 'drafts'}
      draftCount={draftCount}
      /* Per address, for the folder under a colleague's name - offered on the
         same terms as the tab above: only where there is something in it. This
         reader's own writing on that address, never the colleague's. */
      draftCounts={draftCounts}
      /* On the same terms as Drafts: away until there is something in it, and
         kept while somebody is standing in it, so the last message going out
         does not pull the list out from under whoever is reading it. */
      showScheduled={scheduledCount > 0 || currentTab === 'scheduled'}
      scheduledCount={scheduledCount}
      spamCount={spamCount}
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
      lastCheckedAt={lastCheckedAt}
      timezone={timezone}
    />
    </>
  )

  // Campaigns, laid out the way the post is: every campaign down the middle
  // column, the one that is open beside it. It used to be a single full-width
  // form reached through a Back button, which meant that seeing what another
  // campaign was doing cost leaving the one you were looking at - and the
  // address a pinger can be pointed at is minted here, on the one screen that
  // explains what it is for.
  if (params.campaignsOnly) {
    if (!canCampaign) {
      return (
        <div className="uin-page">
          <InboxStyles />
          <NavProgress routeKey={routeKey} />
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
        <NavProgress routeKey={routeKey} />
        {/* The same frame as the inbox, so the rail, the list and the pane are
            the same widths and the same edges on both screens - and so the
            handles between them are the ones somebody has already dragged. On a
            phone it is one pane at a time, exactly as the post is: the list, or
            the campaign opened from it. */}
        <div
          className="uin-app"
          data-open={params.campaignId || searchParams.view === 'suppressions' ? '1' : '0'}
          data-context="off"
        >
          {rail}
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
          <ColumnResizer />
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
      status={askStatus}
      /* Whose list it is. Null on this reader's own, which says "you"; a
         colleague's name on theirs, where the controls also come off - where
         somebody else's job stands is between them and whoever asked, and a
         button that the route would refuse is worse than no button. */
      ownerName={folderOwnerName}
      canSettle={!folderAsked}
      now={new Date()}
      timezone={timezone}
    />
  ) : params.draftsOnly || params.scheduledOnly ? (
    <DraftListView
      base={base}
      params={carried}
      drafts={params.scheduledOnly ? scheduled : drafts}
      scheduled={params.scheduledOnly}
      /* Whose folder this is. Null on this reader's own, where a row opens the
         writing box it was left in; a colleague's name on theirs, where the
         rows open a read-only view instead. Never set on Scheduled: there is
         one of those and it is the reader's own. */
      ownerName={params.draftsOnly && !draftsAreOwn ? folderOwnerName : null}
      inboxNames={Object.fromEntries(allInboxes.map((i) => [i.id, i.name]))}
      openThreadId={params.threadId}
      openDraftId={params.draftId}
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
      mine={sentOwnerId !== null}
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
      meId={user.id}
      inboxNames={Object.fromEntries(allInboxes.map((i) => [i.id, i.name]))}
      showAvatars={settings.showAvatars}
      neverSynced={neverSynced}
      spam={params.spamOnly}
      spamOwnerName={params.spamOnly ? folderOwnerName : null}
      canManage={canManage}
      /* Blocking a pile of senders at once changes what everybody on the site
         receives from now on, so it takes the grant for acting on the outside
         world rather than the one for reading it - the same line the single
         conversation's junk button draws. */
      canBlock={canSendOut}
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
  const otherPane = cannotComposePane ?? draftReadPane ?? importPane ?? organisationPane ?? personPane
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
      <NavProgress routeKey={routeKey} />

      {/* Everything below can raise the five-second offer to take a press back,
          and it is raised HERE so that it outlives whatever raised it: junking a
          conversation shuts the pane the button was in, and snoozing a picked
          pile empties the bar the press came from. See UndoProvider. */}
      <UndoProvider>

      {/* Never a fourth column beside a conversation.
          There used to be one - what the rest of the site knows about whoever
          this is - and on any window narrower than 1500px it stacked UNDERNEATH
          the conversation, which is to say under the note bar, at the bottom of
          however many thousand pixels of quoted email the thread happened to
          hold. Nobody scrolled to it, and it cost a query per record-keeping
          module per conversation opened. What is worth knowing beside a
          conversation is what it is ABOUT, and that is one line in the pinned
          header. The rest is the person's own page, one click away. */}
      <div
        className="uin-app"
        data-open={opened ? '1' : '0'}
        data-context="off"
        data-find={params.searchPage ? '1' : '0'}
      >
        {rail}

        {/* A search's own head, across the list and the conversation both.
            After the rail in the markup rather than before it, because the rail
            is where the reader was and this is what they asked for; the grid
            puts it above both columns either way. */}
        {params.searchPage && (
          <SearchBar
            base={base}
            params={carried}
            inboxes={inboxes.map((i) => ({ id: i.id, name: i.name }))}
            channels={channels.map((c) => ({ key: c.key, label: c.label }))}
            showUnrouted={canManage}
            oldestFirst={params.oldestFirst}
          />
        )}

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
            {/* And on a search's own screen, where the head above holds every
                cut and the tab row below has come off with them: without this
                the column of results would be the one list on the hub with
                nothing at all saying what it is or how much of it there is. */}
            {/* And every Spam folder, colleague's or your own. A colleague's
                needs the name - nothing else on the screen says whose bin you
                are looking into. Your own needs the line because the tab row
                that used to carry the total is no longer drawn there, and a
                folder that cannot say how much is in it is a folder people
                count by hand. */}
            {(listing || params.searchPage || params.spamOnly)
              && !params.contactsOnly && (!params.mentionsOnly || !!folderOwnerName) && (
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
                showSearch={!params.searchPage}
              />
            ) : params.mentionsOnly ? (
              /* The same four choices the conversation list has, narrowing the
                 same three states - the difference being whose they are. Only
                 the tabs: the other filters up here cut a list of post by who
                 sent it and when, and this is a list of jobs. */
              <StatusTabs
                base={base}
                params={carried}
                status={askStatus}
                counts={askCounts}
                unit="asked about"
                ariaLabel={folderOwnerName
                  ? `Where an ask stands with ${folderOwnerName}`
                  : 'Where an ask stands with you'}
              />
            ) : listing || params.searchPage ? null : (
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
                  /* Their own address, where "who is this on" has one answer
                     all the way down and the menu is a switch instead. */
                  ownInbox={!!pinnedInboxId && params.inboxId === pinnedInboxId}
                  /* The Spam folder, and only for somebody who may read the
                     site's settings - which is the grant the list itself takes,
                     because who is blocked is a fact about how the site is set
                     up and it names colleagues. Letting one back in is the
                     other grant, the same one shutting the door takes, so the
                     two are asked separately. */
                  blockedAddresses={params.spamOnly && canManage ? { canUnblock: canSendOut } : null}
                />
                {showStatusTabs && (
                  <StatusTabs
                    base={base}
                    params={carried}
                    status={status}
                    counts={statuses}
                    showUnassigned={showUnassigned}
                  />
                )}
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
      </UndoProvider>
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
