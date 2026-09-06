// ---------------------------------------------------------------------------
// The reading screen's pure half: what the URL means, what a row says, and
// where a quoted reply stops being new writing and starts being history.
//
// All of it is here rather than in a component for two reasons. It is the part
// worth testing, and the panel is a server component - the tabs, the list and
// the thread are all rendered from the query string, because the core Inbox
// host renders only the tab the URL asks for and hands the params straight
// through. Anything held in client state would describe a screen the server had
// not drawn.
// ---------------------------------------------------------------------------

import { calendarDateIn, formatInSiteTimezone, wallClockDaysAhead } from '@/lib/config/timezone'

export const PER_PAGE = 25

export type StatusFilter = 'open' | 'snoozed' | 'done' | 'all'

export type InboxParams = {
  /** The inbox chosen in the tabs, or null for everything this person may see. */
  inboxId: string | null
  /** A channel another module owns, chosen in the tabs. Written `m:<module>` in
   *  the address, because it takes the same place as an inbox and there is no
   *  sense in two params that cannot both be true. */
  providerModule: string | null
  /** The "Not filed" tab: mail that reached the account and matched
   *  none of the site's addresses. Only somebody who administers the whole
   *  thing sees it at all. */
  unroutedOnly: boolean
  /** The "Drafts" tab: this person's own half-written messages,
   *  across every address they can write from. It takes the same slot as an
   *  inbox because it is the same choice - what the list is a list of. */
  draftsOnly: boolean
  /** The "Sent" tab: everything that has left, across every address this person
   *  may read. Takes the same slot for the same reason. */
  sentOnly: boolean
  /** The "Contacts" tab: the address book rather than the post. Takes the same
   *  slot as an inbox because it is the same choice - what the list on the left
   *  is a list of. */
  contactsOnly: boolean
  /** The "Campaigns" tab: the same email to a great many people. Same slot
   *  again, and the same reason. */
  campaignsOnly: boolean
  /** The "Mentioned" tab: conversations colleagues have tagged this person in.
   *  Same slot again - it is a list of things to work through, and which list
   *  is on the left is one choice. */
  mentionsOnly: boolean
  /** Which colleague's address the Sent or Mentioned list above is narrowed to,
   *  or null for this reader's own across every address they can read. The rail
   *  offers no Drafts folder under a colleague - a draft is its author's - but
   *  an address typed into this slot beside `drafts` still narrows the reader's
   *  OWN drafts to the ones filed on it, which is all the query will hand back.
   *
   *  Written into the same slot as everything else - `sent:<id>` - because it is
   *  the same choice, what the list on the left is a list of, and two params
   *  that cannot both be true have no business being two params. Null on every
   *  other tab: an inbox chosen in the ordinary way is `inboxId`, and reading
   *  one out of the other is how a Sent folder ends up scoped to a conversation
   *  list's address. */
  folderInboxId: string | null
  /** Which campaign is open, if any. */
  campaignId: string | null
  /** Which half of the address book is being listed. Only read on the Contacts
   *  tab, where the two are the same people seen from either end. */
  contactsView: ContactsView
  /** The organisation whose own card is open, if any. */
  organisationId: string | null
  /** The label the contacts list is narrowed to, if any. */
  categoryId: string | null
  /** Bringing an address book in from a file. */
  importing: boolean
  /** Whether the open card is being corrected rather than read. */
  editingContact: boolean
  status: StatusFilter
  unreadOnly: boolean
  /** Which end of the list to start at. Only ever the two, and only ever off
   *  the one word in the address - nothing a reader types reaches an ORDER BY
   *  (see THREAD_LIST_ORDER in lib/db.ts). */
  oldestFirst: boolean
  /** A user id, the literal 'unassigned', or null for no filter. */
  assignee: string | null
  search: string | null
  /** The narrower cuts the search dialog can add on top of the words: who it
   *  came from, who it went to, what the subject says, whether anything is
   *  attached, and the two ends of a date range. All of them optional, all of
   *  them read off the address like everything else on this screen. */
  fromText: string | null
  toText: string | null
  subjectText: string | null
  withAttachment: boolean
  /** Calendar dates, "YYYY-MM-DD", meant in the site's own timezone. Kept as
   *  the strings they arrived as: turning them into instants needs the zone,
   *  which this file has no business knowing. */
  after: string | null
  before: string | null
  page: number
  /** The conversation open on the right, if any. */
  threadId: string | null
  /** Composing a brand new message rather than answering one. */
  composing: boolean
  /** Which of the four the compose button was asked for. An email unless the
   *  address says otherwise, so every link written before the menu existed
   *  still opens the thing it always opened. */
  composeKind: ComposeKind
  /** The draft being finished, if the address names one. */
  draftId: string | null
  /** The person whose own page is open, if any. Takes the same place on the
   *  screen as a conversation, because it answers the same question about the
   *  same human from a different angle. */
  personId: string | null
}

export type ContactsView = 'people' | 'organisations'

/** The four things the new-message button can start. `email` is what the button
 *  itself does; the other three are on the little menu beside it. */
export type ComposeKind = 'email' | 'discussion' | 'sms' | 'call'

const COMPOSE_KINDS: ComposeKind[] = ['email', 'discussion', 'sms', 'call']

/** What `?compose=` says, read defensively. '1' is the email composer and
 *  predates the menu, so every link written before it still opens what it
 *  always opened. Anything else at all opens nothing: a value nobody wrote is a
 *  mistyped address rather than an instruction, and this screen has always
 *  treated it that way. */
export function parseComposeKind(raw: string | undefined): ComposeKind | null {
  if (!raw) return null
  if (raw === '1') return 'email'
  return COMPOSE_KINDS.includes(raw as ComposeKind) ? (raw as ComposeKind) : null
}

const STATUSES: StatusFilter[] = ['open', 'snoozed', 'done', 'all']

/** What "start a new one" is written as in the address. A word rather than a
 *  blank, so a link that dropped its value cannot be mistaken for it. */
export const NEW_CONTACT = 'new'

/** One of the search dialog's own boxes, trimmed and capped. Same ceiling as
 *  the words themselves: nothing on this screen has any business handing a
 *  thousand characters to a LIKE. */
function text(raw: string | undefined): string | null {
  const value = (raw ?? '').trim()
  return value.length > 0 ? value.slice(0, 200) : null
}

/** A calendar date off the address, or null for anything that is not one.
 *  Checked properly rather than by shape alone: "2026-13-45" is the right
 *  length and the wrong date, and Date.UTC would roll it forward into February
 *  rather than complain. */
function calendarDate(raw: string | undefined): string | null {
  const value = (raw ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [y, m, d] = value.split('-').map(Number) as [number, number, number]
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? value : null
}

/** The three lists that can be looked at inside ONE address as well as across
 *  every address somebody can read. Written `sent:<inbox id>` in the query
 *  string, which is what the folders under a colleague's name on the rail point
 *  at. */
const SCOPED_FOLDERS = ['sent', 'drafts', 'mentions'] as const

type ScopedFolder = (typeof SCOPED_FOLDERS)[number]

/**
 * What the `inbox` param says, once the prefixes are off it.
 *
 * Pure and tiny, and out here because "sent" and "sent:abc" mean the same list
 * scoped two different ways, and reading that in three separate ternaries below
 * is how one of them ends up disagreeing with the other two. An empty id after
 * the colon is not a scope - it is a link that lost its value - and falls back
 * to the unscoped folder rather than to an address nobody has.
 */
function readFolder(inbox: string): { folder: ScopedFolder | null; inboxId: string | null } {
  for (const folder of SCOPED_FOLDERS) {
    if (!inbox.startsWith(`${folder}:`)) continue
    const id = inbox.slice(folder.length + 1)
    return { folder, inboxId: id.length > 0 ? id : null }
  }
  return { folder: null, inboxId: null }
}

/**
 * The query string, read defensively. A mistyped ?page= once reached a database
 * query as NaN elsewhere in this codebase and rendered an error page instead of
 * page one, so everything here falls back rather than throws.
 */
export function parseInboxParams(sp: Record<string, string> = {}): InboxParams {
  const rawStatus = sp.status as StatusFilter | undefined
  const search = (sp.q ?? '').trim()
  const inbox = sp.inbox ?? ''
  // Anything with the channel prefix takes the channel slot, whether or not it
  // names a real one - "m:" alone is nobody's inbox id either.
  const isChannel = inbox.startsWith('m:')
  const channel = isChannel ? inbox.slice(2) : ''
  const scoped = readFolder(inbox)
  return {
    inboxId:
      !isChannel && !scoped.folder
        && inbox && inbox !== 'all' && inbox !== 'none' && inbox !== 'drafts'
        && inbox !== 'sent' && inbox !== 'contacts' && inbox !== 'campaigns'
        && inbox !== 'mentions'
        ? inbox
        : null,
    providerModule: channel.length > 0 ? channel : null,
    unroutedOnly: inbox === 'none',
    draftsOnly: inbox === 'drafts' || scoped.folder === 'drafts',
    sentOnly: inbox === 'sent' || scoped.folder === 'sent',
    contactsOnly: inbox === 'contacts',
    campaignsOnly: inbox === 'campaigns',
    mentionsOnly: inbox === 'mentions' || scoped.folder === 'mentions',
    folderInboxId: scoped.inboxId,
    campaignId: sp.campaign ? sp.campaign : null,
    contactsView: sp.view === 'organisations' ? 'organisations' : 'people',
    organisationId: sp.org ? sp.org : null,
    categoryId: sp.cat ? sp.cat : null,
    importing: sp.import === '1',
    editingContact: sp.edit === '1',
    status: rawStatus && STATUSES.includes(rawStatus) ? rawStatus : 'open',
    unreadOnly: sp.unread === '1',
    oldestFirst: sp.sort === 'oldest',
    assignee: sp.assignee ? sp.assignee : null,
    search: search.length > 0 ? search.slice(0, 200) : null,
    fromText: text(sp.from),
    toText: text(sp.to),
    subjectText: text(sp.subject),
    withAttachment: sp.att === '1',
    after: calendarDate(sp.after),
    before: calendarDate(sp.before),
    page: Math.max(1, parseInt(sp.page ?? '1', 10) || 1),
    threadId: sp.id ? sp.id : null,
    composing: parseComposeKind(sp.compose) !== null,
    composeKind: parseComposeKind(sp.compose) ?? 'email',
    draftId: sp.draft ? sp.draft : null,
    personId: sp.person ? sp.person : null,
  }
}

/** Rebuild the screen's own address with one or two things changed. Anything
 *  set to null drops out, so "clear the search" and "back to page one" are the
 *  same operation as any other. */
export function inboxHref(
  base: string,
  current: Record<string, string>,
  changes: Record<string, string | null>,
): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries({ ...current, ...changes })) {
    if (v === null || v === undefined || v === '') continue
    params.set(k, String(v))
  }
  const query = params.toString()
  return query ? `${base}?${query}` : base
}

/** What the search dialog can ask for. Every field is what somebody typed or
 *  picked, which is why they are all strings: the builder below is the one
 *  place they become an address, and it is the piece worth testing. */
export type SearchRequest = {
  /** Conversations, or the address book. Two different lists, one box. */
  mode: 'conversations' | 'contacts'
  /** The words themselves. */
  q: string
  /** Where to look: an inbox id, `m:<module>`, or 'all' for everything this
   *  person may see - which is what the dialog opens on, because a search that
   *  quietly only covered the inbox somebody happened to be standing in is the
   *  reason they could not find the message. */
  scope: string
  from: string
  to: string
  subject: string
  withAttachment: boolean
  unreadOnly: boolean
  /** One of the four statuses. 'all' by default: something answered and filed
   *  three weeks ago is exactly what people come to a search box for. */
  status: StatusFilter
  after: string
  before: string
}

export const EMPTY_SEARCH: SearchRequest = {
  mode: 'conversations',
  q: '',
  scope: 'all',
  from: '',
  to: '',
  subject: '',
  withAttachment: false,
  unreadOnly: false,
  status: 'all',
  after: '',
  before: '',
}

/**
 * The address a search asks for.
 *
 * Pure, and here rather than in the dialog, because what a search means is a
 * question about the query string and the query string is this file's job.
 * Everything already in the address survives except the things a new search has
 * no business keeping: the page, whatever was open beside the list, and the
 * composer.
 *
 * The address book takes the words and nothing else - "from" and "has an
 * attachment" are questions about post, and a contacts list cannot answer
 * them - so they are dropped rather than carried along invisibly.
 */
export function buildSearchHref(
  base: string,
  current: Record<string, string>,
  request: SearchRequest,
): string {
  const cleared = { page: null, id: null, person: null, compose: null, draft: null }
  const value = (raw: string) => {
    const trimmed = raw.trim()
    return trimmed.length > 0 ? trimmed.slice(0, 200) : null
  }
  if (request.mode === 'contacts') {
    return inboxHref(base, current, {
      ...cleared,
      inbox: 'contacts',
      q: value(request.q),
      // The narrower cuts belong to the post, and so do the two views of it.
      from: null, to: null, subject: null, att: null, after: null, before: null,
      status: null, unread: null, assignee: null,
    })
  }
  return inboxHref(base, current, {
    ...cleared,
    // The address book's own params go with it rather than lingering over a
    // list of conversations.
    view: null, org: null, edit: null, import: null, cat: null,
    inbox: request.scope || 'all',
    q: value(request.q),
    from: value(request.from),
    to: value(request.to),
    subject: value(request.subject),
    att: request.withAttachment ? '1' : null,
    unread: request.unreadOnly ? '1' : null,
    // Open is what the ordinary list shows and needs no saying; the other three
    // are a deliberate choice and go in the address.
    status: request.status === 'open' ? null : request.status,
    after: calendarDate(request.after),
    before: calendarDate(request.before),
  })
}

/**
 * The dialog's boxes, filled in from the address it was opened over.
 *
 * So that opening search on a list somebody has already narrowed shows what
 * they narrowed it with, rather than an empty form that would quietly throw it
 * away the moment they pressed Search. Takes the raw query string rather than
 * the parsed params because the dialog is a client component holding strings,
 * and the parsed shape would only have to be turned back into them.
 */
export function searchRequestFrom(current: Record<string, string>): SearchRequest {
  const inbox = current.inbox ?? ''
  const contacts = inbox === 'contacts'
  const status = current.status as StatusFilter | undefined
  // Whether the list underneath is already the answer to a search. It settles
  // where the dialog opens pointed: everywhere, when somebody is simply reading
  // an inbox and has come here BECAUSE they cannot find something - and at
  // whatever they chose last time, when they are refining the search they are
  // already looking at.
  const narrowed = !!(current.q || current.from || current.to || current.subject
    || current.att || current.after || current.before)
  return {
    mode: contacts ? 'contacts' : 'conversations',
    q: current.q ?? '',
    // Drafts, Sent, Contacts and Campaigns are not places to search in - they
    // are other lists entirely - so a search opened over one of them looks
    // everywhere rather than nowhere.
    scope: narrowed ? searchableScope(inbox) : 'all',
    from: current.from ?? '',
    to: current.to ?? '',
    subject: current.subject ?? '',
    withAttachment: current.att === '1',
    unreadOnly: current.unread === '1',
    // Anything already chosen stands; a search opened fresh looks everywhere,
    // because something dealt with a fortnight ago is exactly what people come
    // to a search box for.
    status: status && STATUSES.includes(status) ? status : 'all',
    after: current.after ?? '',
    before: current.before ?? '',
  }
}

/** The tabs a search can be pointed at: one address, one channel, the mail that
 *  landed nowhere, or the lot. The other four are not narrower views of the
 *  post - they are different lists altogether - so a search opened over one of
 *  them looks everywhere rather than at nothing. */
const NOT_A_SCOPE = ['drafts', 'sent', 'contacts', 'campaigns']

function searchableScope(inbox: string): string {
  if (!inbox || NOT_A_SCOPE.includes(inbox)) return 'all'
  // One colleague's Sent or Drafts is the same kind of thing narrowed to one
  // address, and searching it means searching that address - not a folder the
  // dialog has no way to express.
  const scoped = readFolder(inbox)
  if (scoped.folder) return scoped.inboxId ?? 'all'
  return inbox
}

/** A calendar date, as somebody would write it. No timezone involved and none
 *  wanted: "2026-09-03" is a date rather than an instant, and putting it
 *  through a formatter with a zone is how a date becomes the day before. */
export function formatCalendarDate(value: string): string {
  const [y, m, d] = value.split('-').map(Number)
  if (!y || !m || !d) return value
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${d} ${months[m - 1] ?? ''} ${y}`.trim()
}

/** Whether the list on screen is the answer to a search rather than a plain
 *  view of an inbox. Asked in three places - the empty state, the chips, the
 *  dialog - so it is written once. */
export function isSearching(params: InboxParams): boolean {
  return !!params.search
    || !!params.fromText
    || !!params.toText
    || !!params.subjectText
    || params.withAttachment
    || !!params.after
    || !!params.before
}

/**
 * Which address a brand new message should go out as.
 *
 * Whichever inbox the list is showing, when that is one this person may send
 * from - "write a new one" from inside accounts@ means writing as accounts@,
 * and having to pick it again from a menu is the sort of thing that gets
 * forgotten and sends the supplier a note from hi@. Everything else - the All
 * view, Not filed, a channel another module owns, or an inbox this person may
 * read but not write from - falls back to the first they can send from, and
 * null when there is none. The menu is still there either way.
 */
export function chooseSendingInbox(
  sendableIds: string[],
  currentInboxId: string | null,
): string | null {
  if (currentInboxId && sendableIds.includes(currentInboxId)) return currentInboxId
  return sendableIds[0] ?? null
}

/**
 * Which tab the hub opens on when the address names none.
 *
 * Somebody with an address of their own lands on it rather than on All, which
 * is the whole point of having one - and it is decided here, before the params
 * are read, so every query, count and link on the screen is built from the same
 * answer. `all` is a real value rather than the absence of one for exactly this
 * reason: without it there would be no way to ask for All at all.
 */
export function effectiveInboxParam(
  raw: string | undefined,
  defaultInboxId: string | null,
): string | undefined {
  if (raw) return raw
  return defaultInboxId ?? undefined
}

/**
 * The addresses along the top, with one person's own pulled to the front.
 *
 * `rest` stays in the site's own order, which is what the drag saves and what
 * everybody else sees. Pinning is per person and changes nothing for anybody
 * else, so it happens here at the last moment rather than in the query.
 *
 * A default naming an address this person cannot see - taken off the guest list
 * since, or removed altogether - pins nothing rather than showing a tab that
 * would not open.
 */
export function pinDefaultInbox<T extends { id: string }>(
  inboxes: T[],
  defaultInboxId: string | null,
): { pinned: T | null; rest: T[] } {
  const pinned = defaultInboxId
    ? inboxes.find((i) => i.id === defaultInboxId) ?? null
    : null
  if (!pinned) return { pinned: null, rest: inboxes }
  return { pinned, rest: inboxes.filter((i) => i.id !== pinned.id) }
}

/**
 * The rail's three groups of addresses: the ones that are this person's, the
 * ones the business shares, and colleagues' own post this person has been let
 * in to.
 *
 * Built on `pinDefaultInbox` rather than beside it, because there are two
 * different ways an address ends up under Yours and they are not the same fact.
 * An INDIVIDUAL inbox this person OWNS is theirs by its nature. A SHARED inbox
 * pinned as their own is a preference: purchasing@ is still the team's, it is
 * simply the one this person opens the hub on. Both belong at the top, and only
 * the second of them is per person.
 *
 * The third group is what an individual inbox someone ELSE owns became the day
 * one could be opened to a colleague - covering somebody's post while they are
 * away, working their diary. It is emphatically not "Yours", it is not the
 * business's either, and it must not be draggable: where it sits is decided by
 * whose it is. An individual inbox whose owner's account has gone belongs to
 * nobody, so it sits here too rather than being called somebody's.
 *
 * `shared` stays in the site's own order, which is what the drag saves and what
 * everybody else sees.
 */
export function splitInboxes<
  T extends { id: string; kind: 'individual' | 'shared'; ownerUserId?: string | null },
>(
  inboxes: T[],
  defaultInboxId: string | null,
  meUserId: string,
): { yours: T[]; shared: T[]; team: T[] } {
  const individual = inboxes.filter((i) => i.kind === 'individual')
  const mine = individual.filter((i) => i.ownerUserId === meUserId)
  const team = individual.filter((i) => i.ownerUserId !== meUserId)
  const { pinned, rest } = pinDefaultInbox(
    inboxes.filter((i) => i.kind !== 'individual'),
    defaultInboxId,
  )
  return { yours: pinned ? [...mine, pinned] : mine, shared: rest, team }
}

export function pageCount(total: number, perPage: number = PER_PAGE): number {
  if (total <= 0) return 1
  return Math.ceil(total / perPage)
}

const CHANNEL_LABELS: Record<string, string> = {
  email: 'Email',
  chat: 'Live chat',
  form: 'Contact form',
  phone: 'Phone',
  sms: 'Text',
  discussion: 'Discussion',
}

/** What a channel is called in front of somebody who does not build websites. */
export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? 'Message'
}

/**
 * Where somebody's own picture is served from, or null when there is nobody to
 * look up.
 *
 * Addressed by WHO rather than by what their email hashes to, deliberately: the
 * hash never appears in the page, so nothing in the markup can be lifted and
 * asked of Gravatar by anybody else. The route does the looking up and answers
 * 404 when nobody has published one, which is what the initials underneath are
 * for. Here rather than in lib/avatars.ts because this file is read by the
 * browser and that one is not - it opens DNS sockets.
 */
export function avatarHref(kind: 'person' | 'user', id: string | null | undefined): string | null {
  return id ? `/api/m/unified-inbox/avatar/${kind}/${encodeURIComponent(id)}` : null
}

/** The name to show for a conversation, falling back through what we actually
 *  know: their name, then their address, then an honest admission. */
export function participantLabel(row: {
  participantName: string | null
  participantAddress: string | null
}): string {
  const name = row.participantName?.trim()
  if (name) return name
  const address = row.participantAddress?.trim()
  if (address) return address
  return 'Unknown sender'
}

/** One or two letters for the avatar circle. Deliberately not a colour: the
 *  circle is decoration, and nothing about who sent a message may depend on
 *  being able to tell two colours apart. */
export function initialsFor(label: string): string {
  const cleaned = label.replace(/[^\p{L}\p{N}\s@.]/gu, ' ').trim()
  if (!cleaned) return '?'
  const words = cleaned.split(/[\s@.]+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[1]![0]!).toUpperCase()
}

/**
 * When something happened, in the shortest form that is still unambiguous.
 * Today gets a clock, this week gets a weekday, anything older gets a date -
 * which is how a person scanning a list actually reads time.
 */
export function formatWhen(value: Date | string | null, now: Date, timezone: string): string {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const diff = now.getTime() - date.getTime()
  // "Today" and "this year" are questions about a calendar, and a calendar
  // belongs to a zone. `toDateString()`/`getFullYear()` answer in the server's
  // own, which is UTC - so a message sent at half past midnight was filed under
  // yesterday for the whole of British Summer Time.
  const dayOfDate = calendarDateIn(date, timezone)
  const dayOfNow = calendarDateIn(now, timezone)
  if (dayOfDate === dayOfNow) {
    return formatInSiteTimezone(date, timezone, { hour: '2-digit', minute: '2-digit' })
  }
  if (diff < 7 * 86_400_000 && diff >= 0) {
    return formatInSiteTimezone(date, timezone, { weekday: 'short' })
  }
  if (dayOfDate.slice(0, 4) === dayOfNow.slice(0, 4)) {
    return formatInSiteTimezone(date, timezone, { day: 'numeric', month: 'short' })
  }
  return formatInSiteTimezone(date, timezone, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** The long form, for the header of one message where there is room to be
 *  exact and somebody may be working out what happened when. */
export function formatFull(value: Date | string | null, timezone: string): string {
  if (!value) return ''
  return formatInSiteTimezone(value, timezone, {
    weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

/** How long a snooze lasts, offered as the handful of answers people actually
 *  give. Computed from a passed-in `now` so the tests are not at the mercy of
 *  the clock. */
export function snoozeOptions(now: Date, timezone: string): Array<{ id: string; label: string; until: Date }> {
  const later = new Date(now.getTime() + 3 * 3_600_000)
  // "Tomorrow morning" has to mean nine o'clock to the person reading it.
  // `setHours(9, ...)` sets nine on the server's clock, which is UTC, so every
  // snooze came back an hour late from March to October.
  const tomorrow = wallClockDaysAhead(now, 1, '09:00', timezone)
  const nextWeek = wallClockDaysAhead(now, 7, '09:00', timezone)
  return [
    { id: 'later', label: 'In three hours', until: later },
    { id: 'tomorrow', label: 'Tomorrow morning', until: tomorrow },
    { id: 'week', label: 'Next week', until: nextWeek },
  ]
}

// ---------------------------------------------------------------------------
// Quoted history.
//
// Every reply carries the whole conversation underneath it, and showing that
// inline means the fourth message in a thread is four copies of the first. Both
// halves below find where the new writing stops; the caller collapses the rest
// behind something the reader can open.
// ---------------------------------------------------------------------------

/** Lines a mail client puts above the copy of what it is answering. */
const ATTRIBUTION_RE =
  /^(on .+wrote:\s*$|-{2,}\s*original message\s*-{2,}|-{2,}\s*forwarded message\s*-{2,}|from:\s.+)/i

/** Split plain text into what was written now and what is being quoted. */
export function splitQuotedText(text: string): { body: string; quoted: string | null } {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (ATTRIBUTION_RE.test(line)) {
      // A quote that starts on line one is the whole message - somebody
      // forwarding something with no covering note - so there is nothing to
      // hide behind a toggle.
      if (i === 0) return { body: text, quoted: null }
      return {
        body: lines.slice(0, i).join('\n').trimEnd(),
        quoted: lines.slice(i).join('\n').trim(),
      }
    }
    // A run of quoted lines with nothing but blank lines after it.
    if (line.startsWith('>') && i > 0) {
      const rest = lines.slice(i)
      if (rest.every((l) => l.trim() === '' || l.trim().startsWith('>'))) {
        return {
          body: lines.slice(0, i).join('\n').trimEnd(),
          quoted: rest.join('\n').trim(),
        }
      }
    }
  }
  return { body: text, quoted: null }
}

/** Containers the common mail clients wrap a quoted reply in. Matched on the
 *  opening tag only, because the closing one is somewhere the far side of
 *  however much markup the sender's client produced. */
const HTML_QUOTE_MARKERS = [
  /<blockquote\b/i,
  /<div\b[^>]*class="[^"]*gmail_quote/i,
  /<div\b[^>]*id="[^"]*(divRplyFwdMsg|appendonsend)/i,
  /<div\b[^>]*class="[^"]*(moz-cite-prefix|yahoo_quoted|OutlookMessageHeader)/i,
]

/**
 * Where the quoted history begins in an HTML body, or -1 when there is none.
 *
 * Index rather than a split, because the caller has to close whatever tags were
 * open at that point and the browser is better at that than a regular
 * expression is: the markup goes into a frame of its own, and an unbalanced
 * tag there costs a scrollbar rather than the admin's layout.
 */
export function quotedHtmlIndex(html: string): number {
  let found = -1
  for (const marker of HTML_QUOTE_MARKERS) {
    const match = marker.exec(html)
    if (match && (found === -1 || match.index < found)) found = match.index
  }
  // Right at the top means the whole message is a quote, which is a forward
  // with no covering note rather than a reply with history under it.
  return found <= 0 ? -1 : found
}

/**
 * The addresses along the top with one of them moved to a different place.
 *
 * Pure, and out here rather than inside the component, because "dropped on the
 * one below it" and "dropped on the one it already was" are exactly the cases
 * that are tedious to reproduce with a mouse and trivial to write down. Out of
 * range, or a move to where it already is, returns the list untouched, so the
 * caller can hand a drop straight in without checking first.
 */
export function moveInOrder<T>(list: T[], from: number, to: number): T[] {
  if (from === to) return list
  if (from < 0 || to < 0 || from >= list.length || to >= list.length) return list
  const next = [...list]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  return next
}
