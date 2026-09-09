'use client'

import { useState } from 'react'
import { MERGE_TAGS, MERGE_TAG_HELP } from '@/modules/unified-inbox/lib/campaigns/personalise'
import { when, type CampaignDetail, type StepView } from '../api'
import type { CampaignDraft } from '../draft'

// What it says: the message, the chases after it, and how it is signed off.
//
// The test send is the one button in here, and it is an action rather than a
// save - it saves first, on its own, because sending a test of wording that is
// still only in a box on the screen tells you nothing.

export function WhatSection({
  draft, detail, firstLocked, onChange, onTest,
}: {
  draft: CampaignDraft
  detail: CampaignDetail
  /** Whether the FIRST message is fixed - true the moment a campaign leaves
   *  draft, which is the server's own rule. Some people have had it, and two
   *  versions of one mailshot with no way to tell who got which is worse than
   *  a box that will not take a change. The follow-ups are never locked: a
   *  chase nobody has reached yet is still only writing. */
  firstLocked: boolean
  onChange: (patch: Partial<CampaignDraft>) => void
  /** Saves what is on screen, then sends one to this address. Comes back with
   *  whatever went wrong, or null. */
  onTest: (to: string) => Promise<string | null>
}) {
  const [testTo, setTestTo] = useState('')
  const [testing, setTesting] = useState(false)
  const [testNotice, setTestNotice] = useState('')
  const [testError, setTestError] = useState('')

  const update = (index: number, patch: Partial<StepView>) => {
    onChange({ steps: draft.steps.map((s) => s.stepIndex === index ? { ...s, ...patch } : s) })
  }

  // Reduce rather than Math.max(...[]), which is -Infinity and would make the
  // new step NaN. A campaign always has a step 0, so this never comes up -
  // until the day something deletes one and every box on the section reads
  // "NaN" with no way back.
  const nextIndex = draft.steps.reduce((highest, s) => Math.max(highest, s.stepIndex), -1) + 1

  const addChase = () => {
    const next = nextIndex
    if (next > 3) return
    onChange({
      steps: [...draft.steps, { id: `new-${next}`, stepIndex: next, waitDays: 3, subject: null, body: '' }],
    })
  }

  /**
   * Take a chase out.
   *
   * On a DRAFT the rest are renumbered, so the steps stay 0, 1, 2, 3 and the
   * screen reads the way somebody wrote it.
   *
   * Once it has started they are NOT, and that is the whole of this comment.
   * Everybody waiting is held against a step NUMBER: pull chase 1 out from under
   * a campaign in flight and renumber, and the four hundred people queued for
   * chase 2 are now queued for what used to be chase 3 - they get the wrong
   * email, and nothing anywhere says so. A gap costs nothing: the runner looks
   * for the next step with a HIGHER number, and anybody left waiting on the one
   * that has gone is quietly finished rather than written to.
   */
  const removeChase = (index: number) => {
    const left = draft.steps.filter((s) => s.stepIndex !== index)
    onChange({
      steps: firstLocked ? left : left.map((s, position) => ({ ...s, stepIndex: position })),
    })
  }

  const insertTag = (index: number, tag: string) => {
    const body = draft.steps.find((s) => s.stepIndex === index)?.body ?? ''
    update(index, { body: `${body}{{${tag}|there}}` })
  }

  const sendTest = async () => {
    setTesting(true)
    setTestNotice('')
    setTestError('')
    const failure = await onTest(testTo.trim())
    setTesting(false)
    if (failure) { setTestError(failure); return }
    setTestNotice('Sent. Go and read it in your own mail program - a preview cannot show you what that will look like.')
  }

  return (
    <section className="uin-camp-section">
      <h3>What it says</h3>

      {draft.steps.map((entry) => (
        <div className="uin-camp-part" key={entry.stepIndex}>
          <div className="uin-camp-part-head">
            <strong>{entry.stepIndex === 0 ? 'The message' : `Follow-up ${entry.stepIndex}`}</strong>
            <span className="uin-camp-hint">
              {entry.stepIndex === 0 ? 'What everybody gets' : 'Only to people who have not replied'}
            </span>
            {entry.stepIndex > 0 && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => removeChase(entry.stepIndex)}>
                Remove
              </button>
            )}
          </div>

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
                  // Clearing the box gives '', and Number('') is 0 - which the
                  // server refuses and the column refuses, so the whole page
                  // then would not save because of a box somebody was halfway
                  // through retyping. An empty box means the standing three.
                  onChange={(event) => update(entry.stepIndex, {
                    waitDays: event.target.value.trim() === '' ? 3 : Math.round(Number(event.target.value)),
                  })}
                />
              </div>
              <span className="uin-camp-hint" style={{ flex: '1 1 12rem' }}>
                Counted from the message before it. It keeps to the same hours as everything else, and it does not go
                at all if they have replied.
              </span>
            </div>
          )}

          {entry.stepIndex === 0 && firstLocked && (
            <span className="uin-camp-hint">
              This one has gone out to people, so its wording is fixed. The follow-ups below can still be changed.
            </span>
          )}

          <div className="uin-camp-field">
            <label htmlFor={`subject-${entry.stepIndex}`}>Subject</label>
            <input
              id={`subject-${entry.stepIndex}`}
              className="form-control"
              value={entry.subject ?? ''}
              readOnly={entry.stepIndex === 0 && firstLocked}
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
              readOnly={entry.stepIndex === 0 && firstLocked}
              onChange={(event) => update(entry.stepIndex, { body: event.target.value })}
            />
            {/* Not offered on a message that has gone out. The box beside them
                is read-only, but the buttons wrote to it anyway - one press
                added a tag nobody could see or take out again, and the save
                after it was refused for changing a message people have had. */}
            <div className="uin-camp-tags" hidden={entry.stepIndex === 0 && firstLocked}>
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

      {/* On the highest number left, not on how many there are: a started
          campaign that has had chase 1 taken out keeps the gap, so 0, 2, 3 is
          three steps with nowhere left to put a fourth. */}
      {nextIndex <= 3 && (
        <div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={addChase}>
            Add a follow-up
          </button>
        </div>
      )}

      <div className="uin-camp-part">
        <div className="uin-camp-part-head"><strong>How it is signed off</strong></div>
        <label className="uin-camp-check">
          <input
            type="checkbox"
            checked={draft.includeSignature}
            onChange={(event) => onChange({ includeSignature: event.target.checked })}
          />
          <span>Put the address&rsquo;s usual signature at the bottom</span>
        </label>
        <label className="uin-camp-check">
          <input
            type="checkbox"
            checked={draft.includeUnsubscribe}
            onChange={(event) => onChange({ includeUnsubscribe: event.target.checked })}
          />
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
          <input
            type="checkbox"
            checked={draft.copyToSent}
            onChange={(event) => onChange({ copyToSent: event.target.checked })}
          />
          <span>
            Also file every one in the mailbox&rsquo;s Sent folder
            <br />
            <span className="uin-camp-hint">Off by default - a few thousand copies buries the real correspondence.</span>
          </span>
        </label>
      </div>

      {detail.previews.length > 0 && (
        <details className="uin-camp-why">
          <summary>How it reads for real people off your list</summary>
          {detail.previews.map((preview) => (
            <div className="uin-camp-preview" key={preview.address}>
              <div className="uin-camp-preview-to">To {preview.address}</div>
              <div className="uin-camp-preview-subject">{preview.subject || '(no subject yet)'}</div>
              <div className="uin-camp-preview-body">{preview.body || '(nothing written yet)'}</div>
            </div>
          ))}
        </details>
      )}

      <div className="uin-camp-part">
        <div className="uin-camp-part-head">
          <strong>Send yourself one</strong>
          <span className="uin-camp-hint">Needed before it can start</span>
        </div>
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
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={testing || !testTo.trim()}
            onClick={() => void sendTest()}
          >
            {testing ? 'Sending…' : 'Send a test'}
          </button>
        </div>
        {detail.campaign.testedAt && (
          <span className="uin-camp-hint">Last test sent {when(detail.campaign.testedAt, detail.timezone)}.</span>
        )}
        {testNotice && <div className="alert alert-info" role="status">{testNotice}</div>}
        {testError && <div className="alert alert-danger" role="alert">{testError}</div>}
      </div>
    </section>
  )
}
