import type {
  CampaignPauseKind,
  CampaignStatus,
  CampaignTally,
  RecipientState,
} from '@/modules/unified-inbox/lib/campaigns/types'

// What the campaign screens send and receive.
//
// Dates arrive as strings, because that is what JSON has, and are formatted for
// the reader rather than parsed back into Dates - every one of them is shown
// and none of them is calculated with on this side. The maths that matters
// (when the next one goes, roughly when it finishes) is done on the server, in
// the site's own timezone, and sent already worked out: two answers to "when
// does this finish" that disagree by an hour is worse than one answer.

export type CampaignWindowView = {
  startMinute: number
  endMinute: number
  weekdaysOnly: boolean
  skipDates: string[]
  intervalSeconds: number
  jitterSeconds: number
  dailyCap: number | null
  rampEnabled: boolean
  rampStart: number
}

export type CampaignView = {
  id: string
  name: string
  inboxId: string | null
  status: CampaignStatus
  pauseKind: CampaignPauseKind | null
  pauseReason: string | null
  includeSignature: boolean
  includeUnsubscribe: boolean
  copyToSent: boolean
  excludeColleagues: boolean
  categoryIds: string[]
  startAt: string | null
  testedAt: string | null
  /** When the server last changed it. Used as a key on the editing steps, so a
   *  save replaces what is in the boxes with what the server now says rather
   *  than an effect copying it across. */
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
  window: CampaignWindowView
}

export type CampaignListRow = CampaignView & {
  tally: CampaignTally
  finishesAbout: string | null
}

export type StepView = {
  id: string
  stepIndex: number
  waitDays: number | null
  subject: string | null
  body: string
}

export type RecipientView = {
  id: string
  address: string
  displayName: string | null
  firstName: string | null
  lastName: string | null
  organisationName: string | null
  state: RecipientState
  stepIndex: number
  lastSentAt: string | null
  repliedAt: string | null
  reason: string | null
}

export type Readiness = { problems: string[]; warnings: string[] }

export type CampaignDetail = {
  campaign: CampaignView
  steps: StepView[]
  tally: CampaignTally
  exclusions: Array<{ reason: string; count: number }>
  previews: Array<{ address: string; subject: string; body: string }>
  readiness: Readiness
  timezone: string
  finishesAbout: string | null
}

export type AudienceSummaryView = {
  included: number
  excluded: Array<{ reason: string; count: number }>
  duplicates: number
}

const BASE = '/api/m/unified-inbox/admin'

/** One place that knows what a refusal looks like, so every screen says the
 *  same thing when the server says no. */
async function send<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string; readiness?: Readiness; needsAcceptance?: boolean }> {
  try {
    const response = await fetch(url, {
      ...init,
      headers: init?.body ? { 'Content-Type': 'application/json', ...(init.headers ?? {}) } : init?.headers,
    })
    const body = await response.json().catch(() => null)
    if (!response.ok) {
      return {
        ok: false,
        error: body?.error ?? 'That did not work. Try again in a moment.',
        ...(body?.readiness ? { readiness: body.readiness as Readiness } : {}),
      }
    }
    // A 200 that is not an "ok" is the start route asking whether the warnings
    // have been read. It is not an error and must not be shown as one.
    if (body && body.ok === false && body.needsAcceptance) {
      return { ok: false, error: '', readiness: body.readiness as Readiness, needsAcceptance: true }
    }
    return { ok: true, data: body as T }
  } catch {
    return { ok: false, error: 'The site could not be reached, so nothing has changed.' }
  }
}

export const campaignApi = {
  list: () => send<{ campaigns: CampaignListRow[]; timezone: string }>(`${BASE}/campaigns`),

  create: (name: string, inboxId: string | null) =>
    send<{ id: string }>(`${BASE}/campaigns`, {
      method: 'POST',
      body: JSON.stringify({ name, inboxId }),
    }),

  get: (id: string) => send<CampaignDetail>(`${BASE}/campaigns/${id}`),

  patch: (id: string, patch: Record<string, unknown>) =>
    send<{ ok: true }>(`${BASE}/campaigns/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  remove: (id: string) => send<{ ok: true }>(`${BASE}/campaigns/${id}`, { method: 'DELETE' }),

  audiencePreview: (id: string) =>
    send<{ summary: AudienceSummaryView; finishesAbout: string | null; firstGoesAt: string | null }>(
      `${BASE}/campaigns/${id}/audience`,
    ),

  buildAudience: (id: string, mode: 'rebuild' | 'topUp') =>
    send<{ summary: AudienceSummaryView }>(`${BASE}/campaigns/${id}/audience`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),

  state: (id: string, action: 'start' | 'pause' | 'resume' | 'stop', acceptWarnings = false) =>
    send<{ firstGoesAt?: string | null; finishesAbout?: string | null }>(`${BASE}/campaigns/${id}/state`, {
      method: 'POST',
      body: JSON.stringify({ action, acceptWarnings }),
    }),

  test: (id: string, to: string, stepIndex: number) =>
    send<{ to: string; personalisedFrom: string | null }>(`${BASE}/campaigns/${id}/test`, {
      method: 'POST',
      body: JSON.stringify({ to, stepIndex }),
    }),

  recipients: (id: string, params: { state?: string | null; q?: string | null; page: number }) => {
    const search = new URLSearchParams({ page: String(params.page) })
    if (params.state) search.set('state', params.state)
    if (params.q) search.set('q', params.q)
    return send<{ rows: RecipientView[]; total: number; page: number; perPage: number }>(
      `${BASE}/campaigns/${id}/recipients?${search.toString()}`,
    )
  },

  tick: () => send<{ sent: number; failed: number; replied: number }>(`${BASE}/campaigns/tick`, { method: 'POST' }),

  suppressions: (params: { q?: string | null; page: number }) => {
    const search = new URLSearchParams({ page: String(params.page) })
    if (params.q) search.set('q', params.q)
    return send<{
      rows: Array<{ id: string; address: string; reason: string; note: string | null; createdAt: string }>
      total: number
      page: number
      perPage: number
    }>(`${BASE}/suppressions?${search.toString()}`)
  },

  suppress: (address: string, note: string | null) =>
    send<{ cleared: number }>(`${BASE}/suppressions`, {
      method: 'POST',
      body: JSON.stringify({ address, note }),
    }),

  unsuppress: (id: string) =>
    send<{ ok: true }>(`${BASE}/suppressions?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

/** A moment as somebody would say it, in the site's own zone. Every date on
 *  these screens goes through here so none of them is formatted twice in two
 *  ways. */
export function when(value: string | null | undefined, timezone: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
    timeZone: timezone,
  }).format(date)
}

/** Minutes past midnight as "08:00", for the boxes on the When step. */
export function clock(minute: number): string {
  return `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
}
