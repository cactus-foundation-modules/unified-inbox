'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { MERGE_TAGS, MERGE_TAG_HELP } from '@/modules/unified-inbox/lib/campaigns/personalise'
import { campaignApi, clock, when, type CampaignDetail, type Readiness, type StepView } from './api'
import { CampaignWatch } from './CampaignWatch'
import type { CampaignCategory, CampaignInbox } from './CampaignsPanel'

// One campaign, in the order somebody thinks about it: who it goes to, what it
// says, when it goes, and then watching it go.
//
// Each step saves on its own button rather than as you type. A screen that
// saves every keystroke is a screen where a half-typed subject line is the
// subject line, and this one can send two thousand emails.

const STEPS = [
  { id: 'who', label: 'Who' },
  { id: 'what', label: 'What' },
  { id: 'when', label: 'When' },
  { id: 'watch', label: 'Watch' },
] as const

type Props = {
  campaignId: string
  inboxes: CampaignInbox[]
  categories: CampaignCategory[]
  step: string
  tickUrl: string | null
  onStep: (step: string) => void
  onClose: () => void
}

export function CampaignEditor({ campaignId, inboxes, categories, step, tickUrl, onStep, onClose }: Props) {
  const [detail, setDetail] = useState<CampaignDetail | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<Readiness | null>(null)

  const load = useCallback(async () => {
    const result = await campaignApi.get(campaignId)
    if (!result.ok) { setError(result.error); return }
    setDetail(result.data)
    setError('')
  }, [campaignId])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async loader; every setState runs after an await
  useEffect(() => { void load() }, [load])

  const save = useCallback(async (patch: Record<string, unknown>) => {
    setBusy(true)
    setError('')
    const result = await campaignApi.patch(campaignId, patch)
    setBusy(false)
    if (!result.ok) { setError(result.error); return false }
    setNotice('Saved.')
    await load()
    return true
  }, [campaignId, load])

  const act = useCallback(async (action: 'start' | 'pause' | 'resume' | 'stop', accept = false) => {
    setBusy(true)
    setError('')
    setNotice('')
    const result = await campaignApi.state(campaignId, action, accept)
    setBusy(false)
    if (!result.ok) {
      if (result.needsAcceptance && result.readiness) { setConfirming(result.readiness); return }
      setError(result.error)
      if (result.readiness) setDetail((current) => current ? { ...current, readiness: result.readiness! } : current)
      return
    }
    setConfirming(null)
    if (action === 'start' || action === 'resume') {
      setNotice(result.data.firstGoesAt
        ? `Away it goes. The first one leaves ${when(result.data.firstGoesAt, detail?.timezone ?? 'UTC')}.`
        : 'Away it goes.')
      onStep('watch')
    }
    await load()
  }, [campaignId, detail?.timezone, load, onStep])

  if (!detail) {
    return <div className="uin-empty">{error || 'Looking…'}</div>
  }

  const { campaign, readiness, timezone } = detail
  const running = campaign.status === 'running'
  const editable = campaign.status === 'draft' || campaign.status === 'paused'

  return (
    <>
      <div className="uin-camp-head">
        <div>
          <h2>{campaign.name}</h2>
          <div className="uin-camp-meta">
            <span className="uin-camp-pill" data-state={campaign.status}>{campaign.status === 'draft' ? 'Draft' : campaign.status === 'running' ? 'Sending' : campaign.status === 'paused' ? 'Paused' : campaign.status === 'done' ? 'Finished' : 'Stopped'}</span>
            {detail.finishesAbout && <span>Finishes about {when(detail.finishesAbout, timezone)}</span>}
          </div>
        </div>
        <div className="uin-camp-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>All campaigns</button>
          {running
            ? <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void act('pause')}>Pause</button>
            : (campaign.status === 'draft' || campaign.status === 'paused') && (
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void act(campaign.status === 'draft' ? 'start' : 'resume')}>
                {campaign.status === 'draft' ? 'Start sending' : 'Resume'}
              </button>
            )}
        </div>
      </div>

      {campaign.status === 'paused' && campaign.pauseReason && (
        <div className={campaign.pauseKind === 'manual' ? 'alert alert-info' : 'alert alert-danger'} role="status">
          {campaign.pauseReason}
        </div>
      )}
      {error && <div className="alert alert-danger" role="alert">{error}</div>}
      {notice && <div className="alert alert-info" role="status">{notice}</div>}

      {confirming && (
        <div className="uin-camp-step">
          <h3>Before it goes</h3>
          <ul className="uin-camp-checks">
            {confirming.warnings.map((warning) => (
              <li key={warning} data-level="warning"><span aria-hidden="true">!</span><span>{warning}</span></li>
            ))}
          </ul>
          <div className="uin-camp-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy}
              onClick={() => void act(campaign.status === 'draft' ? 'start' : 'resume', true)}>
              I have read that - send it
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirming(null)}>
              Let me fix it first
            </button>
          </div>
        </div>
      )}

      <div className="uin-camp-filters" role="tablist">
        {STEPS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={step === entry.id}
            className={`btn btn-sm ${step === entry.id ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => onStep(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {step === 'who' && (
        <WhoStep
          // Keyed on what the server last said, so a save or a rebuild puts the
          // server's answer in the boxes instead of an effect copying it there.
          key={`who-${campaign.updatedAt}`}
          detail={detail}
          inboxes={inboxes}
          categories={categories}
          editable={editable}
          onSave={save}
          onReload={load}
        />
      )}
      {step === 'what' && (
        <WhatStep key={`what-${campaign.updatedAt}`} detail={detail} editable={editable} running={running} onSave={save} onReload={load} />
      )}
      {step === 'when' && (
        <WhenStep detail={detail} onSave={save} tickUrl={tickUrl} />
      )}
      {step === 'watch' && (
        <CampaignWatch campaignId={campaignId} detail={detail} onReload={load} />
      )}

      {(readiness.problems.length > 0 || readiness.warnings.length > 0) && step !== 'watch' && (
        <div className="uin-camp-step">
          <h3>Before it can go <small>{readiness.problems.length} to fix</small></h3>
          <ul className="uin-camp-checks">
            {readiness.problems.map((problem) => (
              <li key={problem} data-level="problem"><span aria-hidden="true">&times;</span><span>{problem}</span></li>
            ))}
            {readiness.warnings.map((warning) => (
              <li key={warning} data-level="warning"><span aria-hidden="true">!</span><span>{warning}</span></li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}

// ---- Who ------------------------------------------------------------------

function WhoStep({
  detail, inboxes, categories, editable, onSave, onReload,
}: {
  detail: CampaignDetail
  inboxes: CampaignInbox[]
  categories: CampaignCategory[]
  editable: boolean
  onSave: (patch: Record<string, unknown>) => Promise<boolean>
  onReload: () => Promise<void>
}) {
  const { campaign, tally } = detail
  const [chosen, setChosen] = useState<string[]>(campaign.categoryIds)
  const [inboxId, setInboxId] = useState(campaign.inboxId ?? '')
  const [excludeColleagues, setExclude] = useState(campaign.excludeColleagues)
  const [preview, setPreview] = useState<{ included: number; excluded: Array<{ reason: string; count: number }>; duplicates: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const built = tally.total > 0

  const refreshPreview = useCallback(async () => {
    const result = await campaignApi.audiencePreview(campaign.id)
    if (result.ok) setPreview(result.data.summary)
  }, [campaign.id])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async loader; every setState runs after an await
  useEffect(() => { if (!built) void refreshPreview() }, [built, refreshPreview])

  const toggle = (id: string) => {
    setChosen((current) => current.includes(id) ? current.filter((c) => c !== id) : [...current, id])
  }

  const saveAndPreview = async () => {
    setBusy(true)
    setError('')
    const ok = await onSave({
      categoryIds: chosen,
      inboxId: inboxId || null,
      excludeColleagues,
    })
    if (ok) await refreshPreview()
    setBusy(false)
  }

  const build = async (mode: 'rebuild' | 'topUp') => {
    setBusy(true)
    setError('')
    const result = await campaignApi.buildAudience(campaign.id, mode)
    setBusy(false)
    if (!result.ok) { setError(result.error); return }
    setPreview(result.data.summary)
    await onReload()
  }

  return (
    <div className="uin-camp-step">
      <h3>Who it goes to</h3>

      <div className="uin-camp-field">
        <label htmlFor="uin-camp-inbox">The address it comes from</label>
        <select
          id="uin-camp-inbox"
          className="form-control"
          value={inboxId}
          disabled={!editable}
          onChange={(event) => setInboxId(event.target.value)}
        >
          <option value="">Choose an address</option>
          {inboxes.map((inbox) => (
            <option key={inbox.id} value={inbox.id}>{inbox.name} ({inbox.address})</option>
          ))}
        </select>
        <span className="uin-camp-hint">
          Replies come back to this address and land in your inbox as ordinary conversations.
        </span>
      </div>

      <div className="uin-camp-field">
        <label>Which contacts</label>
        {categories.length === 0
          ? <span className="uin-camp-hint">You have no labels on your contacts yet, so this goes to everybody in the address book. Add labels on the Contacts tab to send to just some of them.</span>
          : (
            <>
              <div className="uin-camp-cats">
                {categories.map((category) => (
                  <button
                    key={category.id}
                    type="button"
                    className="uin-camp-cat"
                    data-on={chosen.includes(category.id) ? '1' : undefined}
                    disabled={!editable}
                    onClick={() => toggle(category.id)}
                  >
                    {category.name}
                  </button>
                ))}
              </div>
              <span className="uin-camp-hint">
                {chosen.length === 0
                  ? 'Nothing picked, so this goes to everybody in your address book.'
                  : 'Anybody with one of these labels.'}
              </span>
            </>
          )}
      </div>

      <label className="uin-camp-check">
        <input
          type="checkbox"
          checked={excludeColleagues}
          disabled={!editable}
          onChange={(event) => setExclude(event.target.checked)}
        />
        <span>
          Leave out colleagues - anybody at one of your own email domains.
          <br />
          <span className="uin-camp-hint">On unless you have a reason. It is what stops a customer mailshot going round the office.</span>
        </span>
      </label>

      {error && <div className="alert alert-danger" role="alert">{error}</div>}

      <div className="uin-camp-actions">
        {editable && (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void saveAndPreview()}>
            Save and count them
          </button>
        )}
        {editable && !built && (
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !preview?.included} onClick={() => void build('rebuild')}>
            Use this list
          </button>
        )}
        {built && (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void build('topUp')}>
            Top up with anyone new
          </button>
        )}
        {built && editable && (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void build('rebuild')}>
            Build it again
          </button>
        )}
      </div>

      {built ? (
        <div className="uin-camp-legend">
          <span><b>{(tally.total - tally.skipped).toLocaleString('en-GB')}</b> on the list</span>
          {tally.skipped > 0 && <span><b>{tally.skipped.toLocaleString('en-GB')}</b> left out</span>}
        </div>
      ) : preview && (
        <div className="uin-camp-legend">
          <span><b>{preview.included.toLocaleString('en-GB')}</b> would get this</span>
          {preview.duplicates > 0 && <span><b>{preview.duplicates}</b> duplicate addresses merged</span>}
        </div>
      )}

      {(built ? detail.exclusions : preview?.excluded ?? []).length > 0 && (
        <div className="uin-camp-field">
          <label>Left out, and why</label>
          <ul className="uin-camp-checks">
            {(built ? detail.exclusions : preview!.excluded).map((row) => (
              <li key={row.reason}>
                <span aria-hidden="true">&ndash;</span>
                <span><b>{row.count.toLocaleString('en-GB')}</b> {row.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ---- What -----------------------------------------------------------------

function WhatStep({
  detail, editable, running, onSave, onReload,
}: {
  detail: CampaignDetail
  editable: boolean
  running: boolean
  onSave: (patch: Record<string, unknown>) => Promise<boolean>
  onReload: () => Promise<void>
}) {
  const { campaign, steps, previews } = detail
  const [draft, setDraft] = useState<StepView[]>(steps)
  const [includeSignature, setSignature] = useState(campaign.includeSignature)
  const [includeUnsubscribe, setUnsubscribe] = useState(campaign.includeUnsubscribe)
  const [copyToSent, setCopyToSent] = useState(campaign.copyToSent)
  const [testTo, setTestTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [testNotice, setTestNotice] = useState('')

  const update = (index: number, patch: Partial<StepView>) => {
    setDraft((current) => current.map((s) => s.stepIndex === index ? { ...s, ...patch } : s))
  }

  const addChase = () => {
    const next = Math.max(...draft.map((s) => s.stepIndex)) + 1
    if (next > 3) return
    setDraft((current) => [...current, {
      id: `new-${next}`, stepIndex: next, waitDays: 3, subject: null, body: '',
    }])
  }

  const removeChase = (index: number) => {
    setDraft((current) => current
      .filter((s) => s.stepIndex !== index)
      // Renumbered so the steps stay 0, 1, 2, 3 with no gap - a chase numbered
      // 3 with no 2 in front of it is a chase that never goes.
      .map((s, position) => ({ ...s, stepIndex: position })))
  }

  const save = async () => {
    setBusy(true)
    setError('')
    const ok = await onSave({
      includeSignature, includeUnsubscribe, copyToSent,
      steps: draft.map((s) => ({
        stepIndex: s.stepIndex,
        waitDays: s.stepIndex === 0 ? null : (s.waitDays ?? 3),
        subject: s.subject,
        body: s.body,
      })),
    })
    setBusy(false)
    if (ok) await onReload()
  }

  const sendTest = async () => {
    setBusy(true)
    setError('')
    setTestNotice('')
    const result = await campaignApi.test(campaign.id, testTo, 0)
    setBusy(false)
    if (!result.ok) { setError(result.error); return }
    setTestNotice(
      `Sent to ${result.data.to}. ${result.data.personalisedFrom
        ? 'It is filled in with a real person off your list, so what you see is what they get.'
        : 'Nobody is on the list yet, so it used your own name.'}`,
    )
    await onReload()
  }

  const insertTag = (index: number, tag: string) => {
    update(index, { body: `${draft.find((s) => s.stepIndex === index)?.body ?? ''}{{${tag}|there}}` })
  }

  return (
    <>
      {draft.map((entry) => (
        <div className="uin-camp-step" key={entry.stepIndex}>
          <h3>
            {entry.stepIndex === 0 ? 'The message' : `Follow-up ${entry.stepIndex}`}
            <small>
              {entry.stepIndex === 0
                ? 'What everybody gets'
                : 'Only to people who have not replied'}
            </small>
          </h3>

          {entry.stepIndex > 0 && (
            <div className="uin-camp-row">
              <div className="uin-camp-field" style={{ flex: '0 0 8rem' }}>
                <label htmlFor={`wait-${entry.stepIndex}`}>Days to wait</label>
                <input
                  id={`wait-${entry.stepIndex}`}
                  className="form-control"
                  type="number"
                  min={1}
                  max={90}
                  value={entry.waitDays ?? 3}
                  onChange={(event) => update(entry.stepIndex, { waitDays: Number(event.target.value) })}
                />
              </div>
              <span className="uin-camp-hint" style={{ flex: '1 1 12rem' }}>
                Counted from the message before it. It goes out in the same working hours as everything else,
                and it does not go at all if they have replied.
              </span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => removeChase(entry.stepIndex)}>
                Remove
              </button>
            </div>
          )}

          <div className="uin-camp-field">
            <label htmlFor={`subject-${entry.stepIndex}`}>Subject</label>
            <input
              id={`subject-${entry.stepIndex}`}
              className="form-control"
              value={entry.subject ?? ''}
              readOnly={entry.stepIndex === 0 && running}
              placeholder={entry.stepIndex === 0 ? 'A short, plain subject' : 'Leave empty to reply to the first one'}
              onChange={(event) => update(entry.stepIndex, { subject: event.target.value || null })}
            />
            {entry.stepIndex > 0 && (
              <span className="uin-camp-hint">
                Left empty, this lands in the same conversation in their mail program, as a reply to what you sent
                first. That is usually what you want.
              </span>
            )}
          </div>

          <div className="uin-camp-field">
            <label htmlFor={`body-${entry.stepIndex}`}>Message</label>
            <textarea
              id={`body-${entry.stepIndex}`}
              className="form-control"
              rows={entry.stepIndex === 0 ? 12 : 7}
              value={entry.body}
              readOnly={entry.stepIndex === 0 && running}
              onChange={(event) => update(entry.stepIndex, { body: event.target.value })}
            />
            <div className="uin-camp-tags">
              {MERGE_TAGS.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="uin-camp-tag"
                  title={`${MERGE_TAG_HELP[tag]}. Click to add it at the end.`}
                  onClick={() => insertTag(entry.stepIndex, tag)}
                >
                  {`{{${tag}}}`}
                </button>
              ))}
            </div>
            <span className="uin-camp-hint">
              Write <code>{'{{first_name|there}}'}</code> and anybody with no first name on their record gets
              &ldquo;there&rdquo; instead of a gap.
            </span>
          </div>
        </div>
      ))}

      {draft.length < 4 && (
        <div className="uin-camp-actions" style={{ marginBottom: '0.9rem' }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={addChase}>
            Add a follow-up
          </button>
        </div>
      )}

      <div className="uin-camp-step">
        <h3>How it is signed off</h3>
        <label className="uin-camp-check">
          <input type="checkbox" checked={includeSignature} onChange={(event) => setSignature(event.target.checked)} />
          <span>Put the address&rsquo;s usual signature at the bottom</span>
        </label>
        <label className="uin-camp-check">
          <input type="checkbox" checked={includeUnsubscribe} onChange={(event) => setUnsubscribe(event.target.checked)} />
          <span>
            Include the unsubscribe footer
            <br />
            <span className="uin-camp-hint">
              Strongly recommended. Marketing email in the UK is expected to carry a way to opt out, and without one
              people press the spam button instead - which does far more damage. Anybody who has already opted out is
              left out either way.
            </span>
          </span>
        </label>
        <label className="uin-camp-check">
          <input type="checkbox" checked={copyToSent} onChange={(event) => setCopyToSent(event.target.checked)} />
          <span>
            Also file every one in the mailbox&rsquo;s Sent folder
            <br />
            <span className="uin-camp-hint">Off by default - a few thousand copies buries the real correspondence.</span>
          </span>
        </label>
      </div>

      {previews.length > 0 && (
        <div className="uin-camp-step">
          <h3>How it reads <small>For real people off your list</small></h3>
          {previews.map((preview) => (
            <div className="uin-camp-preview" key={preview.address}>
              <div className="uin-camp-preview-to">To {preview.address}</div>
              <div className="uin-camp-preview-subject">{preview.subject || '(no subject yet)'}</div>
              <div className="uin-camp-preview-body">{preview.body || '(nothing written yet)'}</div>
            </div>
          ))}
        </div>
      )}

      <div className="uin-camp-step">
        <h3>Send yourself one <small>Needed before it can start</small></h3>
        <div className="uin-camp-row">
          <div className="uin-camp-field" style={{ flex: '2 1 16rem' }}>
            <label htmlFor="uin-camp-test">Where to send the test</label>
            <input
              id="uin-camp-test"
              className="form-control"
              type="email"
              value={testTo}
              placeholder="you@yourcompany.co.uk"
              onChange={(event) => setTestTo(event.target.value)}
            />
          </div>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !testTo.trim()} onClick={() => void sendTest()}>
            Send the test
          </button>
        </div>
        {campaign.testedAt && (
          <span className="uin-camp-hint">Last test sent {when(campaign.testedAt, detail.timezone)}.</span>
        )}
        {testNotice && <div className="alert alert-info" role="status">{testNotice}</div>}
      </div>

      {error && <div className="alert alert-danger" role="alert">{error}</div>}

      {(editable || running) && (
        <div className="uin-camp-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void save()}>
            Save the wording
          </button>
          {running && (
            <span className="uin-camp-hint">
              The first message cannot be changed now that some people have had it. The follow-ups still can.
            </span>
          )}
        </div>
      )}
    </>
  )
}

// ---- When -----------------------------------------------------------------

function WhenStep({
  detail, onSave, tickUrl,
}: {
  detail: CampaignDetail
  onSave: (patch: Record<string, unknown>) => Promise<boolean>
  tickUrl: string | null
}) {
  const { campaign, timezone } = detail
  const w = campaign.window
  const [startTime, setStartTime] = useState(clock(w.startMinute))
  const [endTime, setEndTime] = useState(clock(w.endMinute))
  const [weekdaysOnly, setWeekdays] = useState(w.weekdaysOnly)
  const [interval, setInterval] = useState(w.intervalSeconds)
  const [jitter, setJitter] = useState(w.jitterSeconds)
  const [dailyCap, setDailyCap] = useState(w.dailyCap)
  const [rampEnabled, setRamp] = useState(w.rampEnabled)
  const [rampStart, setRampStart] = useState(w.rampStart)
  const [skipDates, setSkipDates] = useState(w.skipDates.join(', '))
  const [startAt, setStartAt] = useState(campaign.startAt ? toLocalInput(campaign.startAt, timezone) : '')
  const [busy, setBusy] = useState(false)

  const perDay = useMemo(() => {
    const minutes = Math.max(0, toMinute(endTime) - toMinute(startTime))
    const raw = Math.floor((minutes * 60) / Math.max(20, interval))
    return dailyCap ? Math.min(raw, dailyCap) : raw
  }, [dailyCap, endTime, interval, startTime])

  const save = async () => {
    setBusy(true)
    await onSave({
      startAt: startAt || null,
      window: {
        startTime, endTime, weekdaysOnly, intervalSeconds: interval, jitterSeconds: jitter,
        dailyCap: dailyCap ?? null, rampEnabled, rampStart,
        skipDates: skipDates.split(',').map((d) => d.trim()).filter(Boolean),
      },
    })
    setBusy(false)
  }

  return (
    <>
      <div className="uin-camp-step">
        <h3>When it goes <small>All times are your site&rsquo;s own clock</small></h3>

        <div className="uin-camp-row">
          <div className="uin-camp-field">
            <label htmlFor="uin-camp-start">Not before</label>
            <input
              id="uin-camp-start"
              className="form-control"
              type="datetime-local"
              value={startAt}
              onChange={(event) => setStartAt(event.target.value)}
            />
            <span className="uin-camp-hint">Leave empty to begin as soon as you press start.</span>
          </div>
          <div className="uin-camp-field" style={{ flex: '0 0 8rem' }}>
            <label htmlFor="uin-camp-from">Each day from</label>
            <input id="uin-camp-from" className="form-control" type="time" value={startTime}
              onChange={(event) => setStartTime(event.target.value)} />
          </div>
          <div className="uin-camp-field" style={{ flex: '0 0 8rem' }}>
            <label htmlFor="uin-camp-to">until</label>
            <input id="uin-camp-to" className="form-control" type="time" value={endTime}
              onChange={(event) => setEndTime(event.target.value)} />
          </div>
        </div>

        <label className="uin-camp-check">
          <input type="checkbox" checked={weekdaysOnly} onChange={(event) => setWeekdays(event.target.checked)} />
          <span>Weekdays only</span>
        </label>

        <div className="uin-camp-field">
          <label htmlFor="uin-camp-skip">Days to sit out</label>
          <input
            id="uin-camp-skip"
            className="form-control"
            value={skipDates}
            placeholder="2026-12-25, 2026-12-26"
            onChange={(event) => setSkipDates(event.target.value)}
          />
          <span className="uin-camp-hint">
            Bank holidays and the week you are shut. Weekdays only still sends on Christmas Day otherwise.
          </span>
        </div>

        <div className="uin-camp-row">
          <div className="uin-camp-field" style={{ flex: '0 0 9rem' }}>
            <label htmlFor="uin-camp-gap">Seconds between</label>
            <input id="uin-camp-gap" className="form-control" type="number" min={20} max={3600}
              value={interval} onChange={(event) => setInterval(Number(event.target.value))} />
          </div>
          <div className="uin-camp-field" style={{ flex: '0 0 9rem' }}>
            <label htmlFor="uin-camp-jitter">Vary it by up to</label>
            <input id="uin-camp-jitter" className="form-control" type="number" min={0} max={600}
              value={jitter} onChange={(event) => setJitter(Number(event.target.value))} />
            <span className="uin-camp-hint">Seconds. Makes the gaps less machine-like.</span>
          </div>
          <div className="uin-camp-field" style={{ flex: '0 0 9rem' }}>
            <label htmlFor="uin-camp-cap">At most, per day</label>
            <input
              id="uin-camp-cap"
              className="form-control"
              type="number"
              min={1}
              value={dailyCap ?? ''}
              placeholder="No limit"
              onChange={(event) => setDailyCap(event.target.value ? Number(event.target.value) : null)}
            />
          </div>
        </div>

        <label className="uin-camp-check">
          <input type="checkbox" checked={rampEnabled} onChange={(event) => setRamp(event.target.checked)} />
          <span>
            Work up to it gradually
            <br />
            <span className="uin-camp-hint">
              Start at {rampStart} on the first day and double each day after. Worth it if this mailbox normally sends
              a handful a day - a sudden three hundred is what gets a domain noticed.
            </span>
          </span>
        </label>
        {rampEnabled && (
          <div className="uin-camp-field" style={{ maxWidth: '9rem' }}>
            <label htmlFor="uin-camp-ramp">First day</label>
            <input id="uin-camp-ramp" className="form-control" type="number" min={1}
              value={rampStart} onChange={(event) => setRampStart(Number(event.target.value))} />
          </div>
        )}

        <div className="uin-camp-legend">
          <span>About <b>{perDay.toLocaleString('en-GB')}</b> a day at this pace</span>
          {detail.finishesAbout && <span>Finishing about <b>{when(detail.finishesAbout, timezone)}</b></span>}
        </div>

        <div className="uin-camp-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void save()}>
            Save the timings
          </button>
        </div>
      </div>

      <div className="uin-camp-step">
        <h3>What keeps it moving <small>Worth two minutes of your time</small></h3>
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
      </div>
    </>
  )
}

function toMinute(value: string): number {
  const [hh, mm] = value.split(':').map(Number)
  return (hh ?? 0) * 60 + (mm ?? 0)
}

/** An instant as the wall clock the datetime box wants, in the site's zone -
 *  so opening a campaign shows the time that was typed rather than the time the
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
