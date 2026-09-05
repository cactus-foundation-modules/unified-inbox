'use client'

import { useMemo } from 'react'
import { when, type CampaignDetail } from '../api'
import { STANDING_PACE, type CampaignDraft } from '../draft'

// When it goes.
//
// EVERY BOX HERE MAY BE LEFT EMPTY, and every one of them says underneath what
// empty means. The screen used to arrive with 08:00 and 17:00 already in it,
// which is a decision made on somebody's behalf and then dressed up as their
// own; if a campaign is going to keep office hours it should be because
// somebody typed office hours.
//
// Nothing here refuses to save. An empty pair of time boxes is a warning on the
// readiness list, where it can be read and pressed past, rather than a gate.

export function WhenSection({
  draft, detail, tickUrl, onChange,
}: {
  draft: CampaignDraft
  detail: CampaignDetail
  tickUrl: string | null
  onChange: (patch: Partial<CampaignDraft>) => void
}) {
  const perDay = useMemo(() => {
    const from = toMinute(draft.dayFrom) ?? 0
    const to = toMinute(draft.dayTo) ?? 1440
    const gap = Math.max(20, Number(draft.intervalSeconds) || STANDING_PACE)
    const cap = Number(draft.dailyCap) || null
    const raw = Math.floor((Math.max(0, to - from) * 60) / gap)
    return cap ? Math.min(raw, cap) : raw
  }, [draft.dailyCap, draft.dayFrom, draft.dayTo, draft.intervalSeconds])

  return (
    <section className="uin-camp-section">
      <h3>
        When it goes
        <small>All times are your site&rsquo;s own clock. Leave anything empty and it will not be a rule.</small>
      </h3>

      <div className="uin-camp-field">
        <label htmlFor="uin-camp-startat">Do not begin before</label>
        <input
          id="uin-camp-startat"
          className="form-control"
          type="datetime-local"
          value={draft.startAt}
          onChange={(event) => onChange({ startAt: event.target.value })}
        />
        <span className="uin-camp-hint">Empty: it begins the moment you press start.</span>
      </div>

      <div className="uin-camp-row">
        <div className="uin-camp-field" style={{ flex: '0 0 9rem' }}>
          <label htmlFor="uin-camp-from">Each day from</label>
          <input
            id="uin-camp-from"
            className="form-control"
            type="time"
            value={draft.dayFrom}
            onChange={(event) => onChange({ dayFrom: event.target.value })}
          />
        </div>
        <div className="uin-camp-field" style={{ flex: '0 0 9rem' }}>
          <label htmlFor="uin-camp-to">until</label>
          <input
            id="uin-camp-to"
            className="form-control"
            type="time"
            value={draft.dayTo}
            onChange={(event) => onChange({ dayTo: event.target.value })}
          />
        </div>
        <span className="uin-camp-hint" style={{ flex: '1 1 14rem' }}>
          {draft.dayFrom || draft.dayTo
            ? 'Nothing goes outside these hours.'
            : 'Both empty: any hour, including the small ones.'}
        </span>
      </div>

      <label className="uin-camp-check">
        <input
          type="checkbox"
          checked={draft.weekdaysOnly}
          onChange={(event) => onChange({ weekdaysOnly: event.target.checked })}
        />
        <span>
          Weekdays only
          <br />
          <span className="uin-camp-hint">Off: Saturdays and Sundays count as sending days like any other.</span>
        </span>
      </label>

      <div className="uin-camp-field">
        <label htmlFor="uin-camp-skip">Days to sit out</label>
        <input
          id="uin-camp-skip"
          className="form-control"
          value={draft.skipDates}
          placeholder="2026-12-25, 2026-12-26"
          onChange={(event) => onChange({ skipDates: event.target.value })}
        />
        <span className="uin-camp-hint">
          Bank holidays and the week you are shut. Weekdays only still sends on Christmas Day otherwise.
        </span>
      </div>

      <div className="uin-camp-row">
        <div className="uin-camp-field" style={{ flex: '0 0 10rem' }}>
          <label htmlFor="uin-camp-gap">Seconds between</label>
          <input
            id="uin-camp-gap"
            className="form-control"
            type="number"
            min={20}
            max={3600}
            value={draft.intervalSeconds}
            placeholder={String(STANDING_PACE)}
            onChange={(event) => onChange({ intervalSeconds: event.target.value })}
          />
          <span className="uin-camp-hint">Empty: {STANDING_PACE} seconds.</span>
        </div>
        <div className="uin-camp-field" style={{ flex: '0 0 10rem' }}>
          <label htmlFor="uin-camp-jitter">Vary it by up to</label>
          <input
            id="uin-camp-jitter"
            className="form-control"
            type="number"
            min={0}
            max={600}
            value={draft.jitterSeconds}
            placeholder="0"
            onChange={(event) => onChange({ jitterSeconds: event.target.value })}
          />
          <span className="uin-camp-hint">Seconds. Makes the gaps less machine-like.</span>
        </div>
        <div className="uin-camp-field" style={{ flex: '0 0 10rem' }}>
          <label htmlFor="uin-camp-cap">At most, per day</label>
          <input
            id="uin-camp-cap"
            className="form-control"
            type="number"
            min={1}
            value={draft.dailyCap}
            placeholder="No limit"
            onChange={(event) => onChange({ dailyCap: event.target.value })}
          />
          <span className="uin-camp-hint">Empty: no limit.</span>
        </div>
      </div>

      <label className="uin-camp-check">
        <input
          type="checkbox"
          checked={draft.rampEnabled}
          onChange={(event) => onChange({ rampEnabled: event.target.checked })}
        />
        <span>
          Work up to it gradually
          <br />
          <span className="uin-camp-hint">
            Start small on the first day and double each day after. Worth it if this mailbox normally sends a handful
            a day - a sudden three hundred is what gets a domain noticed.
          </span>
        </span>
      </label>
      {draft.rampEnabled && (
        <div className="uin-camp-field" style={{ maxWidth: '10rem' }}>
          <label htmlFor="uin-camp-ramp">First day</label>
          <input
            id="uin-camp-ramp"
            className="form-control"
            type="number"
            min={1}
            value={draft.rampStart}
            placeholder="50"
            onChange={(event) => onChange({ rampStart: event.target.value })}
          />
          <span className="uin-camp-hint">Empty: fifty.</span>
        </div>
      )}

      <div className="uin-camp-legend">
        <span>About <b>{perDay.toLocaleString('en-GB')}</b> a day at this pace</span>
        {detail.finishesAbout && (
          <span>Finishing about <b>{when(detail.finishesAbout, detail.timezone)}</b></span>
        )}
      </div>

      <details className="uin-camp-why">
        <summary>What keeps it moving when nobody is watching</summary>
        <p className="uin-camp-hint" style={{ margin: 0 }}>
          While this screen is open, it sends on time. When nobody is looking, it relies on your site&rsquo;s own
          scheduled round, which on most hosting comes past about once an hour - so an unattended campaign creeps
          along rather than keeping to the gap you set.
        </p>
        {tickUrl && (
          <>
            <p className="uin-camp-hint" style={{ margin: 0 }}>
              To have it keep proper time with nobody watching, point any free website-pinger at this address, once a
              minute. Treat it like a password - anybody with it can nudge your campaigns along.
            </p>
            <div className="uin-camp-clock">
              <code>{tickUrl}</code>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => { void navigator.clipboard?.writeText(tickUrl) }}
              >
                Copy
              </button>
            </div>
          </>
        )}
      </details>
    </section>
  )
}

function toMinute(value: string): number | null {
  if (!value) return null
  const [hh, mm] = value.split(':').map(Number)
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null
  return (hh ?? 0) * 60 + (mm ?? 0)
}
