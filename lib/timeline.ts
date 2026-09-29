import { formatFull } from './list'

// ---------------------------------------------------------------------------
// What has happened to a conversation, said in the conversation.
//
// Every change to where a conversation stands already wrote a row in
// uin_events. Those rows used to be read out in a folded list at the very
// bottom of the pane, which nobody opened - so a conversation that had woken
// from a snooze, come back out of the bin, or had a scheduled reply stood down
// said nothing about it where anybody was looking. Now each one is a line in
// the conversation itself, between the messages, where it happened.
//
// Two decisions live here, both pure and both tested:
//
//   WHAT EACH LINE SAYS. One sentence, in the site's own voice, naming who did
//   it where somebody did, and saying why where nobody did - "A reply arrived,
//   so it is no longer snoozed" rather than "Somebody changed where it stands".
//
//   WHERE EACH LINE GOES. A line caused by a message (a reply waking a snooze,
//   standing down a scheduled reply) carries that message's id and sits
//   directly before it, whatever its timestamp says. Everything else sits after
//   the last message that was already on the screen when it happened - judged
//   by when this site first held each message, not the date written on it,
//   because mail dated ten o'clock and collected at five past was not there to
//   be seen at two minutes past.
//
// What is NOT a line: a note (the note is already in the conversation), and a
// discussion's done or bin, which is the presser's own business and shown to
// them alone - the same way the status itself is theirs alone.
// ---------------------------------------------------------------------------

export type TimelineEvent = {
  id: string
  userId: string | null
  kind: string
  detail: Record<string, unknown> | null
  createdAt: Date
}

export type TimelineMessage = {
  id: string
  sentAt: Date
  /** When this site first held it. */
  createdAt: Date
}

export type TimelineContext = {
  staffById: Record<string, string>
  timezone: string
  /** Whoever is reading. Lines that are one person's own are shown to them
   *  alone. */
  viewerUserId: string
}

export type TimelineLine = {
  event: TimelineEvent
  text: string
}

export type TimelineEntry<M> =
  | { type: 'message'; message: M }
  | { type: 'line'; line: TimelineLine }

/**
 * Every line this reader should see, worded, in the order they happened.
 *
 * Worded in one pass rather than one at a time because a few lines read
 * differently depending on what came before them: a snooze that ran out after
 * a follow-up was set is "nobody replied", not "its snooze ran out".
 */
export function describeEvents(events: TimelineEvent[], ctx: TimelineContext): TimelineLine[] {
  const ordered = [...events].sort(byCreated)
  const lines: TimelineLine[] = []
  // What the most recent sleep was for, so a timed waking can say why it woke.
  // Read off every event, shown or not: a sleep is a sleep whoever set it.
  let lastSleep: Sleep = null
  for (const event of ordered) {
    const text = visibleTo(event, ctx.viewerUserId) ? lineFor(event, ctx, lastSleep) : null
    if (event.kind === 'awaiting') lastSleep = { chase: true, chaseFor: str(event.detail?.userId) }
    else if (event.kind === 'snoozed') lastSleep = { chase: false, chaseFor: null }
    else if (event.kind === 'woken' || event.kind === 'status') lastSleep = null
    if (text) lines.push({ event, text })
  }
  return lines
}

/** Why the conversation was last put to sleep: a follow-up waiting on a reply,
 *  or somebody's own snooze. */
type Sleep = { chase: boolean; chaseFor: string | null } | null

/** Whether this reader should see this line at all. */
export function visibleTo(event: TimelineEvent, viewerUserId: string): boolean {
  // The note itself is in the conversation; a line saying one was left is the
  // same thing twice.
  if (event.kind === 'note') return false
  // A discussion's done and bin are each colleague's own (migration 059), so
  // are the lines that record them.
  if (event.detail?.forUserOnly === true && event.userId !== viewerUserId) return false
  return true
}

/**
 * The lines placed among the messages, oldest first. Reverse the result for a
 * reader who likes the newest message at the top - a line then still sits
 * between the same two messages, which is the point of it.
 */
export function weaveTimeline<M extends TimelineMessage>(
  messages: M[],
  lines: TimelineLine[],
): TimelineEntry<M>[] {
  const ids = new Set(messages.map((m) => m.id))
  // Lines that belong in front of a particular message.
  const before = new Map<string, TimelineLine[]>()
  // Lines placed by time: after the message at this index (-1 = before all).
  const after = new Map<number, TimelineLine[]>()

  for (const line of [...lines].sort((a, b) => byCreated(a.event, b.event))) {
    const anchor = str(line.event.detail?.messageId)
    if (anchor && ids.has(anchor)) {
      push(before, anchor, line)
      continue
    }
    // After the last message that was already here when it happened. A message
    // deleted since, or moved out to its own conversation, leaves its lines to
    // fall back on the clock like any other.
    const at = line.event.createdAt.getTime()
    let slot = -1
    messages.forEach((message, index) => {
      if (message.createdAt.getTime() <= at) slot = index
    })
    push(after, slot, line)
  }

  const out: TimelineEntry<M>[] = []
  for (const line of after.get(-1) ?? []) out.push({ type: 'line', line })
  messages.forEach((message, index) => {
    for (const line of before.get(message.id) ?? []) out.push({ type: 'line', line })
    out.push({ type: 'message', message })
    for (const line of after.get(index) ?? []) out.push({ type: 'line', line })
  })
  return out
}

// ---------------------------------------------------------------------------
// The words.
// ---------------------------------------------------------------------------

function lineFor(
  event: TimelineEvent,
  ctx: TimelineContext,
  lastSleep: Sleep,
): string | null {
  const d = event.detail ?? {}
  const name = (id: string | null | undefined) => (id && ctx.staffById[id]) || null
  const who = name(event.userId) ?? 'Somebody'
  const when = (value: unknown) => {
    const iso = str(value)
    return iso ? formatFull(iso, ctx.timezone) : null
  }

  switch (event.kind) {
    case 'assigned': {
      const to = str(d.to)
      const toName = name(to)
      if (!event.userId) {
        // Nobody pressed anything: it was somebody's own post.
        return toName ? `It went to ${toName}, as it came to their own address` : 'It went to the owner of the address it came to'
      }
      if (!to) return `${who} took everybody's name off it`
      if (to === event.userId) return `${who} took it on`
      return toName ? `${who} handed it to ${toName}` : `${who} handed it on`
    }

    case 'snoozed': {
      const until = when(d.until)
      if (!event.userId && d.afterSend === true) {
        const asked = name(str(d.userId))
        return until
          ? `It went out, so it is snoozed until ${until}${asked ? `, as ${asked} asked` : ''}`
          : 'It went out, so it was snoozed'
      }
      if (d.was === 'snoozed') return until ? `${who} moved its snooze to ${until}` : `${who} moved its snooze`
      return until ? `${who} snoozed it until ${until}` : `${who} snoozed it`
    }

    case 'status': {
      const mine = d.forUserOnly === true ? ' for themselves' : ''
      if (d.status === 'done') return `${who} marked it done${mine}`
      if (d.status === 'open') {
        if (d.was === 'snoozed') return `${who} brought it back before its snooze ran out`
        if (d.was === 'done') return `${who} opened it again${mine}`
        return `${who} put it back in Open`
      }
      return `${who} changed where it stands`
    }

    case 'woken': {
      if (event.userId) return `${who} replied, so it was opened again`
      if (d.cause === 'time') {
        if (lastSleep?.chase) {
          const chaser = name(lastSleep.chaseFor)
          return chaser ? `Nobody replied, so it came back to ${chaser}` : 'Nobody replied, so it came back'
        }
        return 'Its snooze ran out, so it came back'
      }
      // A reply found in a Sent folder, or an answer typed in a channel's own
      // screens: one of us, but not through this hub.
      const outside = d.direction === 'out'
      const arrived = outside ? 'A reply was sent from outside the inbox' : 'A reply arrived'
      return d.was === 'done'
        ? `${arrived}, so it was opened again`
        : `${arrived}, so it is no longer snoozed`
    }

    case 'unbinned': {
      if (!event.userId) return 'A reply arrived, so it came back out of the bin'
      return `${who} took it back out of ${whose(event.userId, str(d.ownerUserId), ctx)} bin`
    }

    case 'binned':
      return `${who} put it in ${whose(event.userId, str(d.ownerUserId), ctx)} bin`

    case 'junked':
      return `${who} moved it to ${whose(event.userId, str(d.ownerUserId), ctx)} junk`

    case 'unjunked':
      return `${who} took it back out of ${whose(event.userId, str(d.ownerUserId), ctx)} junk`

    case 'blocked':
      return 'It came from a sender the site has blocked, so it went straight to junk'

    case 'held':
      return heldLine(event, ctx)

    case 'awaiting': {
      const author = name(str(d.userId))
      const until = when(d.until)
      const back = until ? ` on ${until}` : ''
      return author
        ? `It went out, so it comes back to ${author}${back} if nobody replies`
        : `It went out, so it comes back${back} if nobody replies`
    }

    case 'scheduled_failed': {
      const author = name(str(d.authorUserId))
      const what = d.reply === true ? 'reply' : 'message'
      const whose_ = author ? `${author}'s scheduled ${what}` : `A scheduled ${what}`
      const reason = str(d.reason)
      return `${whose_} did not go out, so it stayed a draft.${reason ? ` ${asSentence(reason)}` : ''}`
    }

    case 'mentioned': {
      const wanted = name(str(d.userId))
      return wanted ? `${who} asked ${wanted} to look` : `${who} asked somebody to look`
    }

    case 'linked': {
      const label = str(d.label)
      return label ? `${who} linked ${label} to it` : `${who} linked a record to it`
    }

    case 'unlinked': {
      const label = str(d.label)
      return label ? `${who} removed the link to ${label}` : `${who} removed a link`
    }

    case 'moved': {
      // Where from and where to, off the names recorded at the time: a mailbox
      // can be renamed or deleted since, and the line should still say where
      // this had been.
      const from = str(d.fromName)
      const to = str(d.toName)
      if (from && to) return `${who} moved it from ${from} to ${to}`
      if (to) return `${who} moved it to ${to}`
      return `${who} moved it to another mailbox`
    }

    case 'renamed': {
      const to = str(d.to)
      return to ? `${who} renamed it to “${to}”` : `${who} renamed it`
    }

    case 'contact_set': {
      const to = str(d.to)
      return to ? `${who} said it is with ${to}` : `${who} let it go back to showing whoever wrote last`
    }

    case 'merged': {
      const to = str(d.subjectTo)
      return to ? `${who} merged it with another and kept the subject “${to}”` : `${who} merged it with another`
    }
    case 'unmerged': return `${who} separated one back out again`
    case 'message_deleted': return `${who} deleted a message from it`
    case 'message_split': return `${who} moved a message out to its own conversation`
    case 'split_from': return `${who} moved a message here out of another conversation`
    case 'text_moved_out': return `${who} moved a text out to the Phone channel`
    case 'text_moved_in': return `${who} moved a text here out of an email conversation`

    default:
      return `${who} changed something`
  }
}

/**
 * A scheduled message stood down, said from where this conversation sits.
 *
 *   cause 'they'      - the person it was going to wrote first. Either on this
 *                       conversation, or (elsewhereThreadId) on another one.
 *   cause 'colleague' - one of us answered first: named when it was done in
 *                       this hub, "from outside the inbox" when it was not.
 *
 * Rows written before any of this was recorded carry only a count, and read as
 * the rule was then: they wrote first.
 */
function heldLine(event: TimelineEvent, ctx: TimelineContext): string {
  const d = event.detail ?? {}
  const count = typeof d.count === 'number' && d.count > 0 ? d.count : 1
  const authors = Array.isArray(d.authorUserIds)
    ? d.authorUserIds.map((id) => (typeof id === 'string' ? ctx.staffById[id] : undefined)).filter((n): n is string => !!n)
    : []
  const plural = count > 1
  const noun = d.allReplies === true
    ? (plural ? 'replies' : 'reply')
    : (plural ? 'messages' : 'message')
  // "Chris's scheduled reply", "Chris's 2 scheduled replies", "2 scheduled
  // replies from Chris and Sam", "a scheduled reply".
  const subject = plural
    ? authors.length === 1
      ? `${authors[0]}'s ${count} scheduled ${noun}`
      : authors.length > 1
        ? `${count} scheduled ${noun} from ${joinNames(authors)}`
        : `${count} scheduled ${noun}`
    : authors.length > 0
      ? `${authors[0]}'s scheduled ${noun}`
      : `a scheduled ${noun}`
  const outcome = plural
    ? 'were cancelled and saved as drafts'
    : 'was cancelled and saved as a draft'

  if (d.cause === 'colleague') {
    const by = event.userId ? ctx.staffById[event.userId] ?? 'A colleague' : null
    return by
      ? `${by} replied first, so ${subject} ${outcome}`
      : `A reply was sent from outside the inbox first, so ${subject} ${outcome}`
  }
  if (str(d.elsewhereThreadId)) {
    return `They wrote in another conversation before ${subject} went out, so ${plural ? 'they' : 'it'} ${outcome}`
  }
  if (!authors.length && !d.cause) {
    // The oldest rows: a count and an address, nothing else.
    return plural
      ? `They wrote first, so ${count} messages waiting to go out to them were cancelled and saved as drafts`
      : 'They wrote first, so a message waiting to go out to them was cancelled and saved as a draft'
  }
  return `They wrote before ${subject} went out, so ${plural ? 'they' : 'it'} ${outcome}`
}

/** "their" when it was the presser's own, the owner's name when somebody was
 *  covering a colleague's post. */
function whose(presserId: string | null, ownerId: string | null, ctx: TimelineContext): string {
  if (!ownerId || ownerId === presserId) return 'their'
  const owner = ctx.staffById[ownerId]
  return owner ? `${owner}'s` : "a colleague's"
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** A reason as a sentence of its own, full stop and all. */
function asSentence(text: string): string {
  const trimmed = text.trim()
  return trimmed.endsWith('.') ? trimmed : `${trimmed}.`
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function byCreated(a: TimelineEvent, b: TimelineEvent): number {
  const diff = a.createdAt.getTime() - b.createdAt.getTime()
  return diff !== 0 ? diff : a.id.localeCompare(b.id)
}

function push<K>(map: Map<K, TimelineLine[]>, key: K, line: TimelineLine): void {
  const list = map.get(key)
  if (list) list.push(line)
  else map.set(key, [line])
}
