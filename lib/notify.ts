// ---------------------------------------------------------------------------
// A nudge from the browser when something new lands.
//
// The hub is a mail program, and the one thing every mail program does that
// this one did not is tell somebody their post has arrived while they are
// looking at something else. A colleague who works purchasing@ all day does
// not want to keep a tab in front of them to find out an order query came in
// twenty minutes ago.
//
// WHOSE POST. Their own address, when they have been given one - which is the
// same address the rail pins to the top and opens on. Somebody who has not
// been given one is nudged about everything they may read, because for them
// "their mailbox" IS the lot; a feature that does nothing at all until an
// administrator sets a preference is a feature nobody discovers.
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
}

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

/**
 * The two lines of the notification itself.
 *
 * One arrival reads like a message, because it is one: who it is from on top,
 * what it is about underneath - the shape every mail program has used for
 * thirty years, and therefore the one nobody has to read twice.
 *
 * Several read like a tally, because a nudge that arrives while somebody is on
 * a call is glanced at rather than read: "4 new messages" answers the whole
 * question, and the names underneath are there for whoever wants them.
 *
 * The scope is named on the tally and not on the single, where the sender's own
 * name is the more useful thing to give the line to.
 */
export function notificationCopy(
  arrivals: Arrival[],
  total: number,
  scopeName: string | null,
): { title: string; body: string } {
  const one = arrivals[0]
  if (total <= 1 && arrivals.length === 1 && one) {
    return {
      title: senderLabel(one.from),
      body: one.subject?.trim() || 'No subject',
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
    body: scopeName ? `${who} - in ${scopeName}` : who,
  }
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
 * ONLY while the window is not the one being used. Somebody reading the list
 * can see what has landed in it - the list IS the notification - so a round of
 * polling while they are looking at it buys nothing and costs the site a
 * function call a minute per open tab. Away from it, in another window or
 * behind another tab, is exactly the case this feature exists for.
 */
export function shouldPoll(state: {
  enabled: boolean
  permission: NotificationPermission | 'unsupported'
  focused: boolean
}): boolean {
  return state.enabled && state.permission === 'granted' && !state.focused
}
