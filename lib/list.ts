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
  status: StatusFilter
  unreadOnly: boolean
  /** A user id, the literal 'unassigned', or null for no filter. */
  assignee: string | null
  search: string | null
  page: number
  /** The conversation open on the right, if any. */
  threadId: string | null
  /** Composing a brand new message rather than answering one. */
  composing: boolean
  /** The draft being finished, if the address names one. */
  draftId: string | null
  /** The person whose own page is open, if any. Takes the same place on the
   *  screen as a conversation, because it answers the same question about the
   *  same human from a different angle. */
  personId: string | null
}

const STATUSES: StatusFilter[] = ['open', 'snoozed', 'done', 'all']

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
  return {
    inboxId:
      !isChannel && inbox && inbox !== 'all' && inbox !== 'none' && inbox !== 'drafts'
        && inbox !== 'sent'
        ? inbox
        : null,
    providerModule: channel.length > 0 ? channel : null,
    unroutedOnly: inbox === 'none',
    draftsOnly: inbox === 'drafts',
    sentOnly: inbox === 'sent',
    status: rawStatus && STATUSES.includes(rawStatus) ? rawStatus : 'open',
    unreadOnly: sp.unread === '1',
    assignee: sp.assignee ? sp.assignee : null,
    search: search.length > 0 ? search.slice(0, 200) : null,
    page: Math.max(1, parseInt(sp.page ?? '1', 10) || 1),
    threadId: sp.id ? sp.id : null,
    composing: sp.compose === '1',
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
}

/** What a channel is called in front of somebody who does not build websites. */
export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? 'Message'
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
export function formatWhen(value: Date | string | null, now: Date = new Date()): string {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const diff = now.getTime() - date.getTime()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) {
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  }
  if (diff < 7 * 86_400_000 && diff >= 0) {
    return date.toLocaleDateString('en-GB', { weekday: 'short' })
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  }
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** The long form, for the header of one message where there is room to be
 *  exact and somebody may be working out what happened when. */
export function formatFull(value: Date | string | null): string {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

/** How long a snooze lasts, offered as the handful of answers people actually
 *  give. Computed from a passed-in `now` so the tests are not at the mercy of
 *  the clock. */
export function snoozeOptions(now: Date): Array<{ id: string; label: string; until: Date }> {
  const later = new Date(now.getTime() + 3 * 3_600_000)
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  const nextWeek = new Date(now)
  nextWeek.setDate(nextWeek.getDate() + 7)
  nextWeek.setHours(9, 0, 0, 0)
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
