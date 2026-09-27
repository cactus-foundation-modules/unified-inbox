// ---------------------------------------------------------------------------
// A nudge from the browser when something new lands.
//
// The hub is a mail program, and the one thing every mail program does that
// this one did not is tell somebody their post has arrived while they are
// looking at something else. A colleague who works purchasing@ all day does
// not want to keep a tab in front of them to find out an order query came in
// twenty minutes ago.
//
// WHOSE POST. Every address this person may read: their own, the shared ones
// they are on the guest list of, and the colleagues' addresses they have been
// let into - the Yours, Shared and Team inboxes sections of the rail, which is
// the same list the access rule (E17) already draws. Somebody covering
// accounts@ this week wants to know accounts@ has post in it, not only their
// own. The channels another module owns (chat, calls, texts) are not mail and
// bring their own alerts; they stay out.
//
// HOW IT GETS THERE. Two ways, the better one first:
//   - a push through the browser's own push service (lib/web-push.ts), sent by
//     the site the moment mail is collected. Arrives with the tab closed, and
//     is the ONLY way a phone is ever told anything: an iPhone runs no page in
//     the background at all, and exposes notifications only to the Home
//     Screen app.
//   - the older round of asking, from an open tab that is behind something
//     else, for the browsers that cannot be pushed to.
//
// WHERE THE PREFERENCE LIVES: the browser, not the database. The permission
// itself is granted per browser per site by the browser, and nobody can grant
// it on somebody's behalf. A row in a table saying "on" while this particular
// Chrome has never been asked would be a setting that describes nothing, and a
// screen that reads it would tell somebody notifications are on while they get
// none. So the answer is kept beside the thing it describes, keyed by user id
// so a shared machine in a warehouse does not hand one person's answer to the
// next person who signs in.
//
// WHAT COUNTS AS NEW is decided by the server's clock, never the browser's.
// A machine whose clock is four minutes fast would otherwise mark mail as
// already seen before it arrived, and a machine four minutes slow would
// announce the same message twice. Every round hands back the server's own
// "now", the browser keeps that verbatim, and hands it back next time.
//
// AND IT IS WHEN THE SITE GOT IT, not the date written on the mail. They are
// minutes apart for every message there is - mail is collected on a timer, on
// the hour, or when the provider rings - and asking "dated since I last looked"
// of a round a minute wide meant anything collected more than a minute after
// it was written was never announced at all. Which, on a site collecting every
// few minutes, was very nearly everything.
// ---------------------------------------------------------------------------

/** One thing that has landed since the browser last looked. Deliberately flat
 *  and stringly-typed: it crosses to the browser as JSON, and a Date put in
 *  here arrives at the other end as a string pretending to be one. */
export type Arrival = {
  threadId: string
  /** What it is about, as far as the channel knows. Null on the ones that have
   *  no subject at all - a text message, a chat. */
  subject: string | null
  /** Whoever sent it, by name where the hub has one and by address or number
   *  where it does not. Null when it has neither, which is rare and not worth
   *  a placeholder in the data - the copy below has one. */
  from: string | null
  /** When it landed, as the server tells it. */
  at: string
  /** Which address it landed in, by name, so somebody reading three of them
   *  can tell the customer's reply from the supplier's invoice. Null when the
   *  reader may not see the address it is filed under. */
  inbox: string | null
  /** Where pressing the nudge goes: the conversation, opened in the address it
   *  landed in. Built by the server, which is the end that knows the admin
   *  area's address. */
  href: string
}

export type ArrivalsReply = {
  /** The server's own clock at the moment it answered. The browser keeps this
   *  and hands it back as `since` next time, so the two ends never have to
   *  agree about what time it is. */
  now: string
  /** Newest first, capped - see MAX_ARRIVALS. Empty on the first round of a
   *  spell away from the screen, which asks with no `since` at all and is only
   *  there to find out what the time is. */
  arrivals: Arrival[]
  /** How many landed in all, including any past the cap. What the copy counts. */
  total: number
  /** Where a nudge about several goes: the list itself. */
  listHref: string
  /** The site's own hi-res app icon, rather than a 32px tab icon blown up: an
   *  address on this origin that the core routes to whatever the admin set
   *  under Branding (BRANDING_DEFAULTS.icon512), handed over by the server
   *  because that is the end allowed to read the core's branding. Chrome, Edge
   *  and Firefox draw it; Safari on a Mac and on an iPhone draw the site's own
   *  app icon of their own accord, which is the same Branding set. */
  icon: string
}

/** What one nudge says and does, whichever road it travels: drawn by the page
 *  itself on the older road, and sealed into the push payload on the newer. */
export type Nudge = {
  title: string
  body: string
  href: string
  /** Which notification this one replaces. One per conversation, so a second
   *  reply on the same thread updates the first rather than stacking; the
   *  tally has one of its own. */
  tag: string
  icon: string
}

/** The oldest a message's own date may be and still be news when it reaches
 *  the site. Covers the slowest collection there is (the six-hourly safety net
 *  behind an account whose provider rings) with room to spare, and keeps a
 *  newly connected account's years of history - all of it collected "now" -
 *  from arriving as one enormous nudge. */
export const MAX_ARRIVAL_AGE_MS = 24 * 60 * 60_000

/** How many arrivals are described one by one before the copy gives up and
 *  counts them instead. One is named; a handful is a number. */
export const MAX_ARRIVALS = 5

/** The furthest back a round will ever look, however old the mark it was handed.
 *  A tab left open over a bank holiday weekend would otherwise come back and
 *  announce four days of post in one go, which is not a nudge, it is a fright.
 *  Twenty minutes is well past any interval the browser polls on, so an
 *  ordinary spell away loses nothing. */
export const MAX_LOOKBACK_MS = 20 * 60_000

/**
 * What the browser handed back, turned into an instant worth querying - or
 * null, meaning "say nothing this round, just tell me the time".
 *
 * Everything that is not a usable instant comes back null rather than throwing:
 * this value has been sitting in somebody's browser since whenever, it is the
 * one field of this request that is not the site's own, and the worst a wrong
 * one should do is cost the reader a single silent round.
 *
 * A mark in the FUTURE is a browser that was handed a `now` from a server whose
 * clock has since been put back, or a stored value somebody edited. Treated as
 * no mark at all rather than clamped to now, because clamping would announce
 * the whole backlog the moment the clock crossed it.
 */
export function parseSince(raw: string | null | undefined, now: number = Date.now()): Date | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 40) return null
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return null
  if (at > now) return null
  return new Date(Math.max(at, now - MAX_LOOKBACK_MS))
}

/** What one arrival is called on a notification, when it has to be called
 *  something. */
export function senderLabel(from: string | null): string {
  const trimmed = from?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : 'Someone new'
}

/** Which addresses a set of arrivals landed in, named once each, in the order
 *  they first appear. */
function inboxNames(arrivals: Arrival[]): string[] {
  const names: string[] = []
  for (const arrival of arrivals) {
    const name = arrival.inbox?.trim()
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

/** "in Sales", "in Sales and Accounts", "in 3 inboxes". */
function whereLabel(names: string[]): string | null {
  if (names.length === 0) return null
  if (names.length === 1) return `in ${names[0]}`
  if (names.length === 2) return `in ${names[0]} and ${names[1]}`
  return `in ${names.length} inboxes`
}

/**
 * The two lines of the notification itself.
 *
 * One arrival reads like a message, because it is one: who it is from on top,
 * what it is about underneath - the shape every mail program has used for
 * thirty years, and therefore the one nobody has to read twice - with the
 * address it landed in after it, because somebody reading their own post, the
 * shared sales@ and a colleague's while they are away needs to know which pile
 * it is on before they get up.
 *
 * Several read like a tally, because a nudge that arrives while somebody is on
 * a call is glanced at rather than read: "4 new messages" answers the whole
 * question, and the names underneath are there for whoever wants them.
 */
export function notificationCopy(
  arrivals: Arrival[],
  total: number,
): { title: string; body: string } {
  const one = arrivals[0]
  const where = whereLabel(inboxNames(arrivals))
  if (total <= 1 && arrivals.length === 1 && one) {
    const subject = one.subject?.trim() || 'No subject'
    return {
      title: senderLabel(one.from),
      body: where ? `${subject} - ${where}` : subject,
    }
  }
  const names: string[] = []
  for (const arrival of arrivals) {
    const name = senderLabel(arrival.from)
    if (!names.includes(name)) names.push(name)
  }
  const listed = names.slice(0, 3).join(', ')
  const rest = names.length - Math.min(names.length, 3)
  const who = rest > 0 ? `${listed} and ${rest} other${rest === 1 ? '' : 's'}` : listed
  return {
    title: `${total} new messages`,
    body: where ? `${who} - ${where}` : who,
  }
}

/** The one tag every tally shares, so a morning away comes back to the latest
 *  count rather than to a stack of them. */
export const TALLY_TAG = 'uin-new-mail'

/** Everything a notification needs, from one round's answer. Null when nothing
 *  landed. */
export function nudgeFor(reply: Pick<ArrivalsReply, 'arrivals' | 'total' | 'listHref' | 'icon'>): Nudge | null {
  const first = reply.arrivals[0]
  if (!first) return null
  const { title, body } = notificationCopy(reply.arrivals, reply.total)
  const single = reply.total <= 1 && reply.arrivals.length === 1
  return {
    title,
    body,
    href: single ? first.href : reply.listHref,
    tag: single ? `uin-thread-${first.threadId}` : TALLY_TAG,
    icon: reply.icon,
  }
}

/** The admin area's inbox screen, given the admin path the site is set to. A
 *  site that has never set one is on the default. */
export function inboxBase(adminPath: string | null | undefined): string {
  const path = adminPath?.trim().replace(/^\/+|\/+$/g, '') || 'cactus-admin'
  return `/${path}/inbox`
}

/** The list a tally opens on. */
export function listHrefFor(base: string): string {
  return `${base}?tab=unified-inbox`
}

/** One conversation, opened in the address it landed in - or on its own, when
 *  the reader may not see that address, in which case the screen picks. */
export function threadHrefFor(base: string, threadId: string, inboxId: string | null): string {
  const params = new URLSearchParams({ tab: 'unified-inbox' })
  if (inboxId) params.set('inbox', inboxId)
  params.set('id', threadId)
  return `${base}?${params.toString()}`
}

/** Where the answer is kept, per person. Keyed by user id so a machine two
 *  colleagues share does not hand the first one's answer to the second. */
export function storageKey(userId: string): string {
  return `uin:notify:${userId}`
}

/** What one browser has settled about this, once somebody has been asked.
 *  `null` back from the reader means nobody has been asked yet, which is the
 *  whole trigger for the offer appearing at all. */
export type Preference = 'on' | 'off'

export function readPreference(
  storage: Pick<Storage, 'getItem'> | null,
  userId: string,
): Preference | null {
  if (!storage) return null
  try {
    const value = storage.getItem(storageKey(userId))
    return value === 'on' || value === 'off' ? value : null
  } catch {
    // Reading storage throws outright in a browser set to block it, and in
    // Safari's private windows. A colleague with cookies locked down gets no
    // nudges, which is the right answer, and certainly not a broken inbox.
    return null
  }
}

export function writePreference(
  storage: Pick<Storage, 'setItem'> | null,
  userId: string,
  value: Preference,
): void {
  if (!storage) return
  try {
    storage.setItem(storageKey(userId), value)
  } catch {
    // Same as above. The preference lasts the visit rather than for ever,
    // which beats an inbox that throws on the way in.
  }
}

/**
 * Whether this browser should be asking the site what has arrived.
 *
 * ONLY while the window is not the one being used, and only when the site
 * cannot push to it. Somebody reading the list can see what has landed in it -
 * the list IS the notification - so a round of polling while they are looking
 * at it buys nothing and costs the site a function call a minute per open tab.
 * And a browser the site pushes to hears about every arrival already; asking
 * as well would only tell it twice.
 */
export function shouldPoll(state: {
  enabled: boolean
  permission: NotificationPermission | 'unsupported'
  focused: boolean
  pushed: boolean
}): boolean {
  return state.enabled && state.permission === 'granted' && !state.focused && !state.pushed
}
