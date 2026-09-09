'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  campaignApi,
  when,
  type AudienceSummaryView,
  type CampaignDetail,
  type Readiness,
} from './api'
import { BackIcon } from '../icons'
import { CampaignWatch } from './CampaignWatch'
import { WhoSection } from './sections/WhoSection'
import { WhatSection } from './sections/WhatSection'
import { WhenSection } from './sections/WhenSection'
import { audienceMoved, draftFrom, faultIn, sameDraft, toPatch, type CampaignDraft } from './draft'
import type { CampaignCategory, CampaignInbox } from './CampaignsPanel'

// ---------------------------------------------------------------------------
// One campaign, on one page, with ONE SAVE BUTTON.
//
// It used to be four tabs with a save button on three of them, each saving a
// different third of the thing, plus a fourth button that quietly turned the
// audience from a number on the screen into rows in a table - and a campaign
// that had not had that fourth button pressed sat there saying "1 would get
// this" directly above "nobody is on the list yet". Every one of those was a
// separate decision the screen made somebody take without telling them what it
// was for.
//
// So: one form, top to bottom, in the order somebody thinks - who, what, when.
// One Save, bottom right, in the same place every single time, and it saves the
// whole page. Saving is also what writes the list down; there is no second
// press. Start sending is not shown at all until the campaign is genuinely
// ready and there is nothing unsaved, because a button that refuses when you
// press it is worse than a button that is not there yet.
//
// Watching it go is on this page too, at the foot of it. It was behind a
// Progress button, which put the wording and what became of it on two screens
// with a toggle between them - so "did that go?" and "why did that one not get
// it?" could not be asked without losing sight of what had actually been sent.
// It only appears once there is somebody on the list: an empty table of five
// thousand rows is not a thing to show anybody writing their first draft.
// ---------------------------------------------------------------------------

type Props = {
  campaignId: string
  inboxes: CampaignInbox[]
  categories: CampaignCategory[]
  tickUrl: string | null
  /** Told whenever the campaign might have started or stopped, so the list
   *  beside this screen - and the ticker that rides on it - keeps up. */
  onStatusChanged: () => void
  /** Back to the list of campaigns. Only drawn on a phone, where the list is
   *  not on the screen beside this. */
  onBack: () => void
  /** Told whenever there is, or is no longer, something unsaved in the boxes -
   *  so the column beside this can ask before it navigates away and takes the
   *  half-written follow-up with it. */
  onUnsavedChange: (unsaved: boolean) => void
}

/**
 * The campaign, the version of it the server last handed over, and what is in
 * the boxes. All three in ONE piece of state, because the only interesting
 * question about them is asked across all three at once - has the server moved
 * since these boxes were filled from it, and was anything typed in the
 * meantime - and two separate useStates cannot answer it without a race.
 */
type Editing = {
  detail: CampaignDetail
  /** The form as the server's copy would fill it in. What "unsaved" is measured
   *  against, and what a clean reload adopts. */
  baseline: CampaignDraft
  draft: CampaignDraft
  /** True when a reload brought back a different campaign while something was
   *  unsaved, so the screen can say the numbers moved under it. */
  moved: boolean
}

export function CampaignEditor({
  campaignId, inboxes, categories, tickUrl, onStatusChanged, onBack, onUnsavedChange,
}: Props) {
  const [editing, setEditing] = useState<Editing | null>(null)
  const [error, setError] = useState('')

  /**
   * Read the campaign again, WITHOUT throwing away what somebody has typed.
   *
   * This used to remount the whole form on every reload - the inner component
   * was keyed on the campaign's updated_at - so topping up the list, pausing
   * it, or a colleague saving from another tab silently emptied every box back
   * to the server's copy. Half-written follow-ups went that way.
   *
   * So: a reload with nothing unsaved puts the server's answer in the boxes, as
   * before. A reload with something unsaved keeps what was typed, moves the
   * baseline underneath it so Save still knows what changed, and says out loud
   * that the campaign moved.
   */
  const load = useCallback(async () => {
    const result = await campaignApi.get(campaignId)
    if (!result.ok) { setError(result.error); return }
    const detail = result.data
    const baseline = draftFrom(detail)
    setEditing((current) => {
      if (!current || current.detail.campaign.id !== detail.campaign.id) {
        return { detail, baseline, draft: baseline, moved: false }
      }
      if (sameDraft(current.baseline, current.draft)) {
        return { detail, baseline, draft: baseline, moved: false }
      }
      return {
        detail,
        baseline,
        draft: stillSaveable(current.draft, baseline, detail),
        moved: true,
      }
    })
    setError('')
  }, [campaignId])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async loader; every setState runs after an await
  useEffect(() => { void load() }, [load])

  const change = useCallback((patch: Partial<CampaignDraft>) => {
    setEditing((current) => (
      current ? { ...current, draft: { ...current.draft, ...patch }, moved: false } : current
    ))
  }, [])

  const unsaved = editing ? !sameDraft(editing.baseline, editing.draft) : false
  // Reported upwards rather than kept to ourselves: the list column is where
  // somebody clicks away from a half-written campaign, and it cannot ask about
  // work it does not know exists. Cleared on the way out, or a screen that has
  // gone stays "unsaved" for ever.
  useEffect(() => {
    onUnsavedChange(unsaved)
    return () => onUnsavedChange(false)
  }, [onUnsavedChange, unsaved])

  if (!editing) return <div className="uin-empty">{error || 'Looking…'}</div>

  return (
    <Campaign
      // Keyed on WHICH campaign, never on its version: a key that changes when
      // the campaign is saved, paused or topped up is a form that empties
      // itself whenever anything happens to the thing it is editing.
      key={editing.detail.campaign.id}
      editing={editing}
      inboxes={inboxes}
      categories={categories}
      tickUrl={tickUrl}
      onChange={change}
      onStatusChanged={onStatusChanged}
      onBack={onBack}
      onReload={load}
    />
  )
}

/**
 * What is kept of somebody's unsaved typing when the campaign changed underneath
 * them.
 *
 * Everything, except the parts the server would now refuse. A campaign that
 * started while the screen was open has its list and its first message fixed
 * from that moment; keeping an edit to either would leave a form that cannot be
 * saved at all, with the offending box greyed out so nobody could put it back.
 * Those snap to the server's copy; everything else is left exactly as typed.
 */
function stillSaveable(
  typed: CampaignDraft,
  server: CampaignDraft,
  detail: CampaignDetail,
): CampaignDraft {
  if (detail.campaign.status === 'draft') return typed
  const firstFromServer = server.steps.find((s) => s.stepIndex === 0)
  return {
    ...typed,
    inboxId: server.inboxId,
    categoryIds: [...server.categoryIds],
    excludeColleagues: server.excludeColleagues,
    steps: typed.steps.map((step) => (
      step.stepIndex === 0 && firstFromServer
        ? { ...step, subject: firstFromServer.subject, body: firstFromServer.body }
        : step
    )),
  }
}

function Campaign({
  editing, inboxes, categories, tickUrl, onChange, onStatusChanged, onReload, onBack,
}: {
  editing: Editing
  inboxes: CampaignInbox[]
  categories: CampaignCategory[]
  tickUrl: string | null
  onChange: (patch: Partial<CampaignDraft>) => void
  onStatusChanged: () => void
  onReload: () => Promise<void>
  onBack: () => void
}) {
  const { detail, baseline: saved, draft } = editing
  const { campaign, readiness, timezone, tally } = detail
  const [preview, setPreview] = useState<AudienceSummaryView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirming, setConfirming] = useState<Readiness | null>(null)
  /** Whether the "send it all again" warning is on screen. Its own state rather
   *  than a window.confirm: what this is about to do takes four lines to say,
   *  and a browser dialog cannot say them. */
  const [restarting, setRestarting] = useState(false)

  const running = campaign.status === 'running'
  const settled = campaign.status === 'done' || campaign.status === 'stopped'
  // Who it goes to is fixed the moment the first one leaves: the route refuses
  // to change it, and offering boxes that cannot be saved is a lie.
  const audienceEditable = campaign.status === 'draft'
  // So is the first message, and for the same reason - some people have had it.
  // This is the route's OWN rule (`!isDraft`), said the same way here. It used
  // to be read as "running", which left a paused campaign offering a box that
  // was refused on save.
  const firstLocked = campaign.status !== 'draft'
  const dirty = !sameDraft(saved, draft)
  const ready = readiness.problems.length === 0

  // Nothing has been written to yet, so the list can still be worked out again
  // from scratch. Once one has gone, rebuilding would throw away the record of
  // who has had it - Top up is the way in from then on.
  const nothingSent = tally.done + tally.replied + tally.bounced
    + tally.complained + tally.failed + tally.unsubscribed === 0

  const refreshPreview = useCallback(async () => {
    const result = await campaignApi.audiencePreview(detail.campaign.id)
    if (result.ok) setPreview(result.data.summary)
  }, [detail.campaign.id])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async loader; every setState runs after an await
  useEffect(() => { if (tally.total === 0) void refreshPreview() }, [refreshPreview, tally.total])

  const change = useCallback((patch: Partial<CampaignDraft>) => {
    setNotice('')
    onChange(patch)
  }, [onChange])

  // Closing the tab on a half-written mailshot. The browser's own "leave site?"
  // is the only thing that can stop that, and it costs one listener - hung on
  // only while there is actually something to lose.
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  /**
   * The one save.
   *
   * Everything on the page in one PATCH, and then - while nothing has gone out
   * and the audience actually moved - the list written down to match. That
   * second half is what used to be a button nobody found.
   */
  const save = useCallback(async (): Promise<boolean> => {
    const fault = faultIn(draft)
    if (fault) { setError(fault); setNotice(''); return false }

    setBusy(true)
    setError('')
    setNotice('')

    const patched = await campaignApi.patch(campaign.id, toPatch(draft, { audience: audienceEditable }))
    if (!patched.ok) { setBusy(false); setError(patched.error); return false }

    if (audienceEditable && nothingSent && (audienceMoved(saved, draft) || tally.total === 0)) {
      const built = await campaignApi.buildAudience(campaign.id, 'rebuild')
      if (!built.ok) { setBusy(false); setError(built.error); return false }
    }

    await onReload()
    setBusy(false)
    setNotice('Saved.')
    return true
  }, [audienceEditable, campaign.id, draft, nothingSent, onReload, saved, tally.total])

  const act = useCallback(async (action: 'start' | 'pause' | 'resume' | 'stop', accept = false) => {
    setBusy(true)
    setError('')
    setNotice('')
    const result = await campaignApi.state(campaign.id, action, accept)
    setBusy(false)
    if (!result.ok) {
      if (result.needsAcceptance && result.readiness) { setConfirming(result.readiness); return }
      setError(result.error)
      return
    }
    setConfirming(null)
    if (action === 'start' || action === 'resume') {
      setNotice(result.data.firstGoesAt
        ? `Away it goes. The first one leaves ${when(result.data.firstGoesAt, timezone)}.`
        : 'Away it goes.')
    }
    await onReload()
    onStatusChanged()
  }, [campaign.id, onReload, onStatusChanged, timezone])

  /**
   * Start it, saving first if anything is unsaved.
   *
   * It used to take two presses and there was no way to know that: Start was
   * simply absent until Save had been pressed, so somebody who had just typed
   * the last sentence of their email saw the button they wanted vanish. One
   * press now does both, in the right order, and stops if the save is refused.
   */
  const startOrResume = useCallback(async () => {
    if (dirty && !await save()) return
    await act(campaign.status === 'draft' ? 'start' : 'resume')
  }, [act, campaign.status, dirty, save])

  const topUp = useCallback(async () => {
    setBusy(true)
    setError('')
    const result = await campaignApi.buildAudience(campaign.id, 'topUp')
    setBusy(false)
    if (!result.ok) { setError(result.error); return }
    const added = result.data.summary.included
    setNotice([
      added === 0 ? 'Nobody new to add.' : `${added.toLocaleString('en-GB')} added.`,
      result.data.restarted ? 'It was marked finished, so it has been set going again.' : '',
    ].filter(Boolean).join(' '))
    await onReload()
    onStatusChanged()
  }, [campaign.id, onReload, onStatusChanged])

  const restart = useCallback(async () => {
    setBusy(true)
    setError('')
    setNotice('')
    const result = await campaignApi.restart(campaign.id)
    setBusy(false)
    if (!result.ok) { setError(result.error); return }
    setRestarting(false)
    setNotice(
      `Back to a draft, with ${result.data.summary.included.toLocaleString('en-GB')} on the list. `
      + 'Nothing has gone out - press Start sending when you are ready.',
    )
    await onReload()
    onStatusChanged()
  }, [campaign.id, onReload, onStatusChanged])

  const sendTest = useCallback(async (to: string): Promise<string | null> => {
    if (!await save()) return 'Nothing was sent, because the campaign could not be saved.'
    const result = await campaignApi.test(campaign.id, to, 0)
    if (!result.ok) return result.error
    await onReload()
    return null
  }, [campaign.id, onReload, save])

  return (
    <>
      <div className="uin-camp-head">
        {/* The way back to the list, on a phone only: there the list is not on
            the screen beside this, and the rail's Campaigns link is behind a
            drawer. Beside an open list the button is not drawn at all - it
            would repeat a column already on screen. */}
        <button type="button" className="uin-thread-close uin-camp-back" onClick={onBack}>
          <span className="uin-back-phone" aria-hidden="true">{BackIcon}<span className="uin-back-words">Back</span></span>
          <span className="sr-only">Back to the list of campaigns</span>
        </button>
        <div className="uin-camp-head-main">
          {/* The name, typed where it is read, rather than in a bordered
              section of its own further down the page. It is one box; it did
              not need a heading, a label and an outline to hold it. */}
          <label className="sr-only" htmlFor="uin-camp-name">What this campaign is called - only you see it</label>
          <input
            id="uin-camp-name"
            className="uin-camp-name-input"
            value={draft.name}
            placeholder="Name this campaign"
            onChange={(event) => change({ name: event.target.value })}
          />
          <div className="uin-camp-meta">
            <span className="uin-camp-pill" data-state={campaign.status}>{statusWord(campaign.status)}</span>
            <span>{summarise(detail)}</span>
            {detail.finishesAbout && <span>Finishes about {when(detail.finishesAbout, timezone)}</span>}
          </div>
        </div>
      </div>

      {campaign.pauseReason && campaign.status !== 'running' && (
        <div className={campaign.pauseKind === 'manual' ? 'alert alert-info' : 'alert alert-danger'} role="status">
          {campaign.pauseReason}
        </div>
      )}
      {error && <div className="alert alert-danger" role="alert">{error}</div>}
      {notice && <div className="alert alert-info" role="status">{notice}</div>}
      {/* The campaign moved while somebody was typing - it was topped up, it
          started, a colleague saved it from another tab. What was typed is
          still in the boxes; this is only so nobody presses Save wondering
          which of the two versions they are about to keep. */}
      {editing.moved && (
        <div className="alert alert-info" role="status">
          This campaign has changed since you started typing - the counts and the state above are the new
          ones. What you had written is still here, and Save keeps it.
        </div>
      )}

      {confirming && (
        <div className="uin-camp-section" data-tone="warning">
          <h3>Before it goes</h3>
          <ul className="uin-camp-checks">
            {confirming.warnings.map((warning) => (
              <li key={warning} data-level="warning"><span aria-hidden="true">!</span><span>{warning}</span></li>
            ))}
          </ul>
          <div className="uin-camp-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => void act(campaign.status === 'draft' ? 'start' : 'resume', true)}
            >
              I have read that - send it
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirming(null)}>
              Let me fix it first
            </button>
          </div>
        </div>
      )}

      {restarting && (
        <div className="uin-camp-section" data-tone="problem">
          <h3>Send this to everybody again? <small>Read this bit</small></h3>
          <ul className="uin-camp-checks">
            <li data-level="problem">
              <span aria-hidden="true">&times;</span>
              <span>
                <b>Everybody on this list gets it a second time</b>, including the
                {' '}{(tally.done + tally.replied + tally.complained).toLocaleString('en-GB')} who have already had it.
                A customer who gets the same email twice unsubscribes, and they are right to.
              </span>
            </li>
            <li data-level="problem">
              <span aria-hidden="true">&times;</span>
              <span>
                <b>The record of what went out last time goes.</b> Who opened it, what bounced, who replied - the
                progress table starts again from nothing. There is no getting it back.
              </span>
            </li>
            <li data-level="warning">
              <span aria-hidden="true">!</span>
              <span>
                Anybody who unsubscribed is still left out, and so is every address that bounced. That much is kept,
                whatever else this does.
              </span>
            </li>
            <li data-level="warning">
              <span aria-hidden="true">!</span>
              <span>
                It comes back as a draft. Nothing leaves until you press Start sending, and the checks run again first.
              </span>
            </li>
          </ul>
          <div className="uin-camp-actions">
            <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => void restart()}>
              {busy ? 'Working…' : 'Yes - send it all again'}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setRestarting(false)}>
              Leave it alone
            </button>
          </div>
        </div>
      )}

      <WhoSection
        draft={draft}
        detail={detail}
        inboxes={inboxes}
        categories={categories}
        editable={audienceEditable}
        preview={preview}
        staleCount={audienceMoved(saved, draft)}
        onChange={change}
      />

      <WhatSection
        draft={draft}
        detail={detail}
        firstLocked={firstLocked}
        onChange={change}
        onTest={sendTest}
      />

      <WhenSection draft={draft} detail={detail} tickUrl={tickUrl} onChange={change} />

      {(readiness.problems.length > 0 || readiness.warnings.length > 0) && !settled && (
        <section className="uin-camp-section" data-tone={ready ? 'warning' : 'problem'}>
          <h3>
            Before it can go
            <small>
              {readiness.problems.length > 0
                ? `${readiness.problems.length} to sort out`
                : 'Nothing stopping it - read these first'}
            </small>
          </h3>
          <ul className="uin-camp-checks">
            {readiness.problems.map((problem) => (
              <li key={problem} data-level="problem"><span aria-hidden="true">&times;</span><span>{problem}</span></li>
            ))}
            {readiness.warnings.map((warning) => (
              <li key={warning} data-level="warning"><span aria-hidden="true">!</span><span>{warning}</span></li>
            ))}
          </ul>
          {dirty && (
            <span className="uin-camp-hint">
              This list was worked out from the last save, so it does not know about what you have just typed.
            </span>
          )}
        </section>
      )}

      {/* What became of it, under what was written - not behind a button beside
          it. Held back until there is a list to look at, because a table of
          nobody under a half-written draft is a screen asking to be scrolled
          past. */}
      {tally.total > 0 && (
        <CampaignWatch campaignId={campaign.id} detail={detail} onReload={onReload} />
      )}

      {campaign.status !== 'draft' && campaign.status !== 'stopped' && (
        <div className="uin-camp-section">
          <h3>
            Anybody who has joined since
            <small>Nobody already on it is touched, unsubscribes included</small>
          </h3>
          <div className="uin-camp-actions">
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void topUp()}>
              Top up the list
            </button>
            {campaign.status === 'done' && (
              <span className="uin-camp-hint">
                This one has finished. Adding anybody sets it going again.
              </span>
            )}
          </div>
        </div>
      )}

      {/* The one bar. Same place on every status, pinned to the foot of the
          pane - so "where do I save this" is never a question, however far down
          the progress table somebody has scrolled. */}
      <div className="uin-camp-bar-actions">
        <span className="uin-camp-hint">
          {settled
            ? 'This one is over. Nothing further will go out - unless you send the whole thing again.'
            : dirty
              ? 'Unsaved changes.'
              : running
                ? 'Sending. The wording of the first message is fixed now; the follow-ups are not.'
                : ready
                  ? 'Ready when you are.'
                  : 'Not ready yet - see “Before it can go” above.'}
        </span>
        <div className="uin-camp-actions">
          {settled && !restarting && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setRestarting(true)}>
              Send it all again
            </button>
          )}
          {(running || campaign.status === 'paused') && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void act('stop')}>
              Stop for good
            </button>
          )}
          {running && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void act('pause')}>
              Pause
            </button>
          )}
          {/* On EVERY status, including finished. A finished campaign still has
              a name worth correcting and follow-up wording worth tidying before
              it is sent again, and the boxes above have always let you type in
              them - there was simply no button, so a form that looked editable
              silently was not. Who it goes to and the first message stay locked
              by the sections themselves. */}
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !dirty} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          {ready && (campaign.status === 'draft' || campaign.status === 'paused') && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => void startOrResume()}
            >
              {campaign.status === 'draft' ? 'Start sending' : 'Resume'}
            </button>
          )}
        </div>
      </div>
    </>
  )
}

/** What has happened so far, in one clause. The head used to say only which
 *  status word applied, which is the one thing the pill beside it already
 *  says. */
function summarise(detail: CampaignDetail): string {
  const { tally } = detail
  const gone = tally.done + tally.replied + tally.bounced + tally.complained + tally.failed
  const onTheList = tally.total - tally.skipped
  if (tally.total === 0) return 'Nobody on the list yet'
  if (gone === 0) return `${onTheList.toLocaleString('en-GB')} on the list, none sent yet`
  return `${gone.toLocaleString('en-GB')} of ${onTheList.toLocaleString('en-GB')} sent`
}

function statusWord(status: CampaignDetail['campaign']['status']): string {
  switch (status) {
    case 'running': return 'Sending'
    case 'paused': return 'Paused'
    case 'draft': return 'Draft'
    case 'stopped': return 'Stopped'
    case 'done': return 'Finished'
  }
}
