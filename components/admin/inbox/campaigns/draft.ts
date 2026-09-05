import { clock, type CampaignDetail, type StepView } from './api'

// ---------------------------------------------------------------------------
// One campaign, as the boxes on the screen hold it.
//
// The whole form is one object with one Save behind it, and this file is the
// only place that knows how that object turns into what the server wants. Two
// rules it exists to keep:
//
// EVERY NUMBER IS A STRING WHILE IT IS BEING TYPED. A number box that is
// really a number cannot be empty - it goes to zero or to NaN the moment
// somebody clears it - and every box on the When section is allowed to be
// empty. So they are held as typed and parsed once, here, on the way out.
//
// EMPTY MEANS NO RESTRICTION, AND SAYS SO. An empty pair of time boxes is not
// "the usual office hours"; it is midnight to midnight, which the readiness
// check then warns about on the way out of the door. Nothing on this screen
// stands for a value nobody typed.
// ---------------------------------------------------------------------------

export type CampaignDraft = {
  name: string
  inboxId: string
  categoryIds: string[]
  excludeColleagues: boolean
  includeSignature: boolean
  includeUnsubscribe: boolean
  copyToSent: boolean
  steps: StepView[]
  /** Wall clock for the datetime box, "" for "as soon as it is started". */
  startAt: string
  /** "HH:MM" or "" for no restriction on the time of day. */
  dayFrom: string
  dayTo: string
  weekdaysOnly: boolean
  /** As typed: "2026-12-25, 2026-12-26". */
  skipDates: string
  intervalSeconds: string
  jitterSeconds: string
  dailyCap: string
  rampEnabled: boolean
  rampStart: string
}

/** The pace an empty gap box means, said once so the box's placeholder and the
 *  server's fallback cannot drift apart. */
export const STANDING_PACE = 90

export function draftFrom(detail: CampaignDetail): CampaignDraft {
  const { campaign } = detail
  const w = campaign.window
  const allDay = w.startMinute <= 0 && w.endMinute >= 1440

  return {
    name: campaign.name,
    inboxId: campaign.inboxId ?? '',
    categoryIds: [...campaign.categoryIds],
    excludeColleagues: campaign.excludeColleagues,
    includeSignature: campaign.includeSignature,
    includeUnsubscribe: campaign.includeUnsubscribe,
    copyToSent: campaign.copyToSent,
    steps: detail.steps.map((step) => ({ ...step })),
    startAt: campaign.startAt ? toLocalInput(campaign.startAt, detail.timezone) : '',
    dayFrom: allDay ? '' : clock(w.startMinute),
    dayTo: allDay ? '' : clock(w.endMinute),
    weekdaysOnly: w.weekdaysOnly,
    skipDates: w.skipDates.join(', '),
    // Blank wherever the value is the one an empty box already means, so a
    // campaign nobody has touched shows a section of empty boxes rather than a
    // section of numbers somebody has to work out whether they chose.
    intervalSeconds: w.intervalSeconds === STANDING_PACE ? '' : String(w.intervalSeconds),
    jitterSeconds: w.jitterSeconds === 0 ? '' : String(w.jitterSeconds),
    dailyCap: w.dailyCap === null ? '' : String(w.dailyCap),
    rampEnabled: w.rampEnabled,
    rampStart: w.rampStart === 50 ? '' : String(w.rampStart),
  }
}

/** What the server is sent. `audience` is held back once a campaign has
 *  started, because the route refuses to change who it goes to at that point
 *  and a refusal is a worse answer than not asking. */
export function toPatch(draft: CampaignDraft, options: { audience: boolean }): Record<string, unknown> {
  return {
    name: draft.name.trim(),
    ...(options.audience
      ? {
          inboxId: draft.inboxId || null,
          categoryIds: draft.categoryIds,
          excludeColleagues: draft.excludeColleagues,
        }
      : {}),
    includeSignature: draft.includeSignature,
    includeUnsubscribe: draft.includeUnsubscribe,
    copyToSent: draft.copyToSent,
    steps: draft.steps.map((step) => ({
      stepIndex: step.stepIndex,
      waitDays: step.stepIndex === 0 ? null : (step.waitDays ?? 3),
      subject: step.subject,
      body: step.body,
    })),
    startAt: draft.startAt || null,
    window: {
      startTime: draft.dayFrom || null,
      endTime: draft.dayTo || null,
      weekdaysOnly: draft.weekdaysOnly,
      skipDates: draft.skipDates.split(',').map((d) => d.trim()).filter(Boolean),
      intervalSeconds: numberOrNull(draft.intervalSeconds),
      jitterSeconds: numberOrNull(draft.jitterSeconds),
      dailyCap: numberOrNull(draft.dailyCap),
      rampEnabled: draft.rampEnabled,
      rampStart: numberOrNull(draft.rampStart),
    },
  }
}

/**
 * What is wrong with it before the server is troubled.
 *
 * Only the things the server would refuse in a sentence nobody can act on -
 * "That change could not be saved" is true and useless. Everything softer is a
 * readiness warning rather than a refusal, and lives on the server where the
 * start button can see it too.
 */
export function faultIn(draft: CampaignDraft): string | null {
  if (!draft.name.trim()) return 'Give the campaign a name - only you see it.'

  const interval = numberOrNull(draft.intervalSeconds)
  if (draft.intervalSeconds.trim() && interval === null) return 'The gap between messages has to be a number of seconds.'
  if (interval !== null && (interval < 20 || interval > 3600)) {
    return 'The gap between messages has to be between 20 seconds and an hour.'
  }

  const jitter = numberOrNull(draft.jitterSeconds)
  if (draft.jitterSeconds.trim() && jitter === null) return 'The amount to vary the gap by has to be a number of seconds.'
  if (jitter !== null && (jitter < 0 || jitter > 600)) return 'The gap can be varied by up to ten minutes, no more.'

  const cap = numberOrNull(draft.dailyCap)
  if (draft.dailyCap.trim() && (cap === null || cap < 1)) return 'The most to send in a day has to be at least one, or empty for no limit.'

  const ramp = numberOrNull(draft.rampStart)
  if (draft.rampEnabled && draft.rampStart.trim() && (ramp === null || ramp < 1)) {
    return 'The first day of the warm-up has to be at least one.'
  }

  if (draft.dayFrom && draft.dayTo && draft.dayFrom >= draft.dayTo) {
    return 'The finishing time has to be after the starting time.'
  }

  const badDate = draft.skipDates.split(',').map((d) => d.trim()).filter(Boolean)
    .find((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))
  if (badDate) return `"${badDate}" is not a date this understands. Write them as 2026-12-25.`

  return null
}

/** Whether two drafts differ in any way somebody typed. Compared as JSON on
 *  purpose: every field on the draft is a string, a boolean or an array of
 *  them, so this is exact rather than nearly. */
export function sameDraft(a: CampaignDraft, b: CampaignDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Whether the list would have to be worked out again to match what is on the
 *  screen. Rebuilding costs a query over every contact, so it is only done when
 *  the answer could actually have changed - or when there is no list at all. */
export function audienceMoved(before: CampaignDraft, after: CampaignDraft): boolean {
  return before.excludeColleagues !== after.excludeColleagues
    || before.categoryIds.join(',') !== after.categoryIds.join(',')
}

function numberOrNull(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? Math.round(parsed) : null
}

/** An instant as the wall clock the datetime box wants, in the site's zone - so
 *  opening a campaign shows the time that was typed rather than the time the
 *  server keeps. */
function toLocalInput(value: string, timezone: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
}
