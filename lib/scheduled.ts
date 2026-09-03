import { calendarDateIn, formatInSiteTimezone, instantAtWallClock } from '@/lib/config/timezone'
import type { DraftSendState } from './types'

// ---------------------------------------------------------------------------
// Sending later: the pure half.
//
// Two decisions live here, and both of them are the sort that go wrong quietly.
//
// WHAT A TYPED TIME MEANS. The box in the composer is a date and a time with no
// zone on it at all - "9:00 on the 4th" - and the person typing it means nine
// o'clock as the site tells the time, not nine o'clock wherever the server
// happens to be standing. So the wall clock travels as it was typed and is
// turned into an instant HERE, against the site's own zone, exactly as the
// snooze options are. Reading it as UTC would post every scheduled message an
// hour early for two thirds of the British year, which is the class of bug that
// only shows up in the customer's mailbox.
//
// WHETHER IT IS A TIME WORTH ACCEPTING. A time in the past is a message that
// goes out on the next run, which is not what anybody meant by "send it later";
// a time in three hundred years is a row nothing will ever collect. Both are
// refused at the point somebody presses the button, with a sentence saying why,
// rather than accepted and quietly ignored.
// ---------------------------------------------------------------------------

/** How soon a message may be scheduled. Under a minute is somebody meaning
 *  "now", and Send already does that better. */
export const MIN_LEAD_MS = 60_000

/** How far ahead one may be scheduled. A year covers every real reason - a
 *  renewal, a birthday, a contract date - and refuses the typo that puts 2206
 *  in the year box. */
export const MAX_AHEAD_DAYS = 366

const MAX_AHEAD_MS = MAX_AHEAD_DAYS * 86_400_000

/** A datetime-local value: "YYYY-MM-DDTHH:MM", with the seconds some browsers
 *  add. Nothing about it says which zone it is in, which is the point. */
const WALL_CLOCK_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/

export type ScheduleDecision =
  | { ok: true; at: Date }
  | { ok: false; reason: string }

/**
 * The instant a typed wall clock means, or why it will not do.
 *
 * `now` is passed in rather than read off the clock so the awkward cases are a
 * test rather than a memory.
 */
export function decideSendAt(value: string, now: Date, timezone: string): ScheduleDecision {
  const match = WALL_CLOCK_RE.exec(value.trim())
  if (!match) {
    return { ok: false, reason: 'Pick the day and the time it should go out.' }
  }
  const at = instantAtWallClock(match[1]!, match[2]!, timezone)
  if (Number.isNaN(at.getTime())) {
    return { ok: false, reason: 'That is not a date and time this understands.' }
  }
  const ahead = at.getTime() - now.getTime()
  if (ahead < MIN_LEAD_MS) {
    return { ok: false, reason: 'Pick a time that has not been and gone. Send it now if you want it to go now.' }
  }
  if (ahead > MAX_AHEAD_MS) {
    return { ok: false, reason: 'That is more than a year away. Pick something nearer.' }
  }
  return { ok: true, at }
}

/** The same instant back in the shape the box in the composer wants, in the
 *  site's zone - so opening a scheduled message shows the time that was typed
 *  rather than the time the server keeps. */
export function toWallClock(at: Date, timezone: string): string {
  const day = calendarDateIn(at, timezone)
  const clock = formatInSiteTimezone(at, timezone, { hour: '2-digit', minute: '2-digit', hour12: false })
  // en-GB gives "09:30"; a stray "24:00" at midnight in some runtimes is the one
  // value datetime-local will not take.
  return `${day}T${clock === '24:00' ? '00:00' : clock}`
}

/** When it goes out, said the way somebody would say it. Long enough to be
 *  unambiguous, because a message leaving at the wrong hour is not something to
 *  find out afterwards. */
export function describeSendAt(at: Date | string | null, now: Date, timezone: string): string {
  if (!at) return ''
  const date = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const clock = formatInSiteTimezone(date, timezone, { hour: '2-digit', minute: '2-digit' })
  const day = calendarDateIn(date, timezone)
  const today = calendarDateIn(now, timezone)
  if (day === today) return `today at ${clock}`
  const tomorrow = calendarDateIn(new Date(now.getTime() + 86_400_000), timezone)
  if (day === tomorrow) return `tomorrow at ${clock}`
  const sameYear = day.slice(0, 4) === today.slice(0, 4)
  const written = formatInSiteTimezone(date, timezone, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
  return `${written} at ${clock}`
}

/** What the row in the list says about a message that has a time on it. Empty
 *  for an ordinary draft, which has nothing extra to say. */
export function scheduleLabel(
  draft: {
    sendAt: Date | string | null
    sendState: DraftSendState
    /** Set when mail from the recipient stood it down. Read only for a draft
     *  with no state left on it, which is what standing one down leaves. */
    heldByThreadId?: string | null
  },
  now: Date,
  timezone: string,
): string {
  // A stood-down message is an ordinary draft again, so it has no state to
  // switch on - and saying nothing about it would put it back in the list
  // looking like something nobody ever finished.
  if (!draft.sendState && draft.heldByThreadId) return 'Held - they wrote first'
  switch (draft.sendState) {
    case 'scheduled':
      return `Goes out ${describeSendAt(draft.sendAt, now, timezone)}`
    case 'sending':
      return 'Going out now'
    case 'failed':
      return 'Did not go out'
    default:
      return ''
  }
}

/** How long a claim may sit unsettled before it is taken to be a run that died
 *  rather than one still working, and the message is put back in the queue. The
 *  send route's own ceiling is sixty seconds, so anything past a few minutes is
 *  not coming back. */
export const STALE_CLAIM_MS = 10 * 60_000

/** Typed text as safe markup, made at the last moment.
 *
 *  The composer holds the same escape (`toHtml`, beside the attachment picker)
 *  for a message going out while somebody watches. A scheduled one is stored as
 *  it was typed and has nobody there when its time comes, so the same four
 *  substitutions have to exist somewhere the server can reach. */
export function plainTextToHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '<br>')
}

// ---------------------------------------------------------------------------
// Chasing it up.
//
// A follow-up is a length of time, not a moment. The moment is not known when
// somebody sets it - the message has not left yet, and it leaves at nine in the
// morning whatever time it was written - so what is stored is "three days after
// it goes", and the moment is worked out once it has actually gone.
//
// It is applied as a SNOOZE on the conversation, which is the whole reason it
// is worth having: a reply already cancels a snooze (reopenOnReply), so a chase
// nobody needs disappears on its own the instant the supplier writes back.
// Nothing has to remember to cancel it, which is the part a reminder of its own
// would get wrong.
// ---------------------------------------------------------------------------

/** The shortest follow-up worth setting. Under a day is a conversation coming
 *  back before the recipient has opened their mail, which teaches people to
 *  ignore it. Matches the column's own check in migration 022. */
export const MIN_FOLLOW_UP_MINUTES = 60 * 24

/** The longest. A year, matching how far ahead a message may be scheduled at
 *  all, and matching the column's check. */
export const MAX_FOLLOW_UP_MINUTES = MAX_AHEAD_DAYS * 24 * 60

/** The handful of answers people actually give, offered rather than a box to
 *  type a number of minutes into. */
export const followUpChoices: ReadonlyArray<{ minutes: number; label: string }> = [
  { minutes: 60 * 24, label: 'A day later' },
  { minutes: 60 * 24 * 3, label: 'Three days later' },
  { minutes: 60 * 24 * 7, label: 'A week later' },
  { minutes: 60 * 24 * 14, label: 'A fortnight later' },
]

/** Whatever came off the wire, or nothing. A number the column would refuse is
 *  refused here instead, where there is somebody to tell. */
export function decideFollowUp(minutes: number | null): { ok: true; minutes: number | null } | { ok: false; reason: string } {
  if (minutes === null) return { ok: true, minutes: null }
  if (!Number.isInteger(minutes)) return { ok: false, reason: 'That is not a length of time this understands.' }
  if (minutes < MIN_FOLLOW_UP_MINUTES) {
    return { ok: false, reason: 'Give them at least a day to answer before it comes back.' }
  }
  if (minutes > MAX_FOLLOW_UP_MINUTES) {
    return { ok: false, reason: 'That is more than a year away. Pick something nearer.' }
  }
  return { ok: true, minutes }
}

/** How long, said the way somebody would say it. Falls back to counting days
 *  for a length nobody picked off the menu. */
export function describeFollowUp(minutes: number | null): string {
  if (!minutes) return ''
  const known = followUpChoices.find((choice) => choice.minutes === minutes)
  if (known) return known.label.toLowerCase()
  const days = Math.round(minutes / (60 * 24))
  return days <= 1 ? 'a day later' : `${days} days later`
}

/** When the conversation should come back, given when the message actually
 *  left. Worked out here rather than at the moment it was set, because a
 *  message that went out late should be chased late. */
export function followUpAt(sentAt: Date, minutes: number): Date {
  return new Date(sentAt.getTime() + minutes * 60_000)
}
