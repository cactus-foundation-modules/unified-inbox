'use client'

import { useId, useState } from 'react'
import type { Caller, Inbox, RetentionForecast, Settings } from './types'
import { CheckField, FieldGroup, FieldRow, FormActions, MUTED, Panel } from './ui'

// ---------------------------------------------------------------------------
// How much mail is collected, how long it is kept, and how a conversation
// reads once it is here.
// ---------------------------------------------------------------------------

export function CollectingPanel({ settings, inboxes, retention, busy, call }: {
  settings: Settings
  inboxes: Inbox[]
  retention: RetentionForecast | null
  busy: boolean
  call: Caller
}) {
  const [draft, setDraft] = useState(settings)
  // Re-seed the form when a save brings fresh settings back. Adjusting state
  // during render rather than in an effect: React re-runs this component
  // immediately with the new value instead of painting the stale one first.
  const [seeded, setSeeded] = useState(settings)
  const fid = useId()
  if (seeded !== settings) {
    setSeeded(settings)
    setDraft(settings)
  }

  // The count below is worked out from what is saved, not from what is being
  // typed above it, so while the two differ it is answering an old question.
  const windowEdited = draft.retentionMonths !== settings.retentionMonths
    || draft.retentionKeepLinked !== settings.retentionKeepLinked

  async function save() {
    await call('/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        backfillMonths: Number(draft.backfillMonths) || 12,
        retentionMonths: draft.retentionMonths === null ? null : Number(draft.retentionMonths) || null,
        retentionKeepLinked: draft.retentionKeepLinked,
        attachmentFetch: draft.attachmentFetch,
        autoLink: draft.autoLink,
        newestFirst: draft.newestFirst,
        defaultInboxId: draft.defaultInboxId || null,
        autoCheckSeconds: draft.autoCheckSeconds,
      }),
    }, 'Settings saved.')
  }

  return (
    <Panel
      title="What gets collected, and how long it is kept"
      blurb={<>
        Mail is gathered on a schedule rather than the second it arrives - about once an hour on a
        paid hosting plan, and once a day on the free one. There is a Check now button on each mail
        account for when you cannot wait.
      </>}
    >
      <FieldGroup first title="Starting out">
        <FieldRow>
          <div className="field">
            <label htmlFor={`${fid}-backfill`}>How far back to go <span style={{ ...MUTED, fontWeight: 400 }}>(months)</span></label>
            <input
              id={`${fid}-backfill`}
              type="number"
              min={0}
              value={draft.backfillMonths}
              onChange={(e) => setDraft({ ...draft, backfillMonths: Number(e.target.value) })}
            />
            <span className="field-hint">Only matters the first time a mailbox is read.</span>
          </div>
          <div className="field">
            <label htmlFor={`${fid}-attach`}>Attachments</label>
            <select
              id={`${fid}-attach`}
              value={draft.attachmentFetch}
              onChange={(e) => setDraft({ ...draft, attachmentFetch: e.target.value as Settings['attachmentFetch'] })}
            >
              <option value="lazy">Fetch one when somebody opens it</option>
              <option value="always">Fetch everything as it arrives</option>
              <option value="never">Never fetch them</option>
            </select>
            <span className="field-hint">Fetching one at a time keeps the site&rsquo;s storage down.</span>
          </div>
        </FieldRow>
      </FieldGroup>

      <FieldGroup
        title="Tidying up"
        hint="Blank means keep everything, which is how every site starts. Set a number and the conversations older than that are removed for good, a few hundred a night, along with any files attached to them. There is no way to get them back afterwards."
      >
        <FieldRow>
          <div className="field">
            <label htmlFor={`${fid}-retention`}>Delete conversations older than <span style={{ ...MUTED, fontWeight: 400 }}>(months)</span></label>
            <input
              id={`${fid}-retention`}
              type="number"
              min={1}
              value={draft.retentionMonths ?? ''}
              placeholder="Keep everything"
              onChange={(e) => setDraft({ ...draft, retentionMonths: e.target.value === '' ? null : Number(e.target.value) })}
            />
          </div>
        </FieldRow>
        <CheckField
          label="Keep a conversation for ever if it has an order, a purchase order or a quote attached"
          checked={draft.retentionKeepLinked}
          onChange={(retentionKeepLinked) => setDraft({ ...draft, retentionKeepLinked })}
          hint="Leave this on unless you have a reason not to. It is what stops a tidy-up aimed at old mailing lists taking the correspondence behind a disputed invoice with it."
        />
        {retention && windowEdited && (
          <div className="alert alert-info">
            <p style={{ margin: 0 }}>
              Save to see what this would remove. The count below is worked out from the setting as it
              stands, not from what you have just typed.
            </p>
          </div>
        )}
        {retention && !windowEdited && (
          <div className="alert alert-info">
            <p style={{ margin: 0 }}>
              As things stand, the next tidy-up would remove <strong>{retention.due}</strong>{' '}
              conversation{retention.due === 1 ? '' : 's'} last written to before{' '}
              {new Date(retention.cutoff).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.
              {retention.keptForLinks > 0 && (
                <> Another <strong>{retention.keptForLinks}</strong> {retention.keptForLinks === 1 ? 'is' : 'are'} old
                enough but {retention.keptForLinks === 1 ? 'is' : 'are'} being kept because something is attached to{' '}
                {retention.keptForLinks === 1 ? 'it' : 'them'}.</>
              )}
            </p>
            {settings.retentionLastRunAt && (
              <p style={{ margin: '0.375rem 0 0', fontSize: '0.8125rem' }}>
                Last tidy-up: {new Date(settings.retentionLastRunAt).toLocaleString('en-GB')}.
              </p>
            )}
          </div>
        )}
      </FieldGroup>

      <FieldGroup title="How the inbox reads">
        <FieldRow>
          <div className="field">
            <label htmlFor={`${fid}-default`}>Which inbox opens first</label>
            <select
              id={`${fid}-default`}
              value={draft.defaultInboxId ?? ''}
              onChange={(e) => setDraft({ ...draft, defaultInboxId: e.target.value || null })}
            >
              <option value="">Whichever comes first</option>
              {inboxes.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </div>
        </FieldRow>
        <CheckField
          label="Show the newest message at the top of a conversation"
          checked={draft.newestFirst}
          onChange={(newestFirst) => setDraft({ ...draft, newestFirst })}
          hint="Off, a conversation reads top to bottom the way it happened. On, the latest message is the first thing you see and the writing box sits with it, which saves scrolling past a long back and forth to find out what was last said."
        />
        <FieldRow>
          <div className="field">
            <label htmlFor={`${fid}-autocheck`}>Check for new mail while the inbox is open</label>
            <select
              id={`${fid}-autocheck`}
              value={draft.autoCheckSeconds === null ? '' : String(draft.autoCheckSeconds)}
              onChange={(e) => setDraft({
                ...draft,
                autoCheckSeconds: e.target.value === '' ? null : Number(e.target.value),
              })}
            >
              <option value="">No - only on the schedule, or when I press the button</option>
              <option value="60">Every minute</option>
              <option value="120">Every 2 minutes</option>
              <option value="300">Every 5 minutes</option>
              <option value="600">Every 10 minutes</option>
              <option value="1800">Every half hour</option>
            </select>
            <span className="field-hint">
              Only while somebody has the inbox open and is actually looking at that tab, and only
              for people who look after the mail accounts. A tab left behind another window stops
              checking until it comes back to the front. The more often you ask, the more work your
              hosting does, so pick the longest wait you can live with.
            </span>
          </div>
        </FieldRow>
        <CheckField
          label="Attach an order or a purchase order to a conversation when the message mentions one"
          checked={draft.autoLink}
          onChange={(autoLink) => setDraft({ ...draft, autoLink })}
          hint="Nothing is attached until the number has been checked against your own records."
        />
      </FieldGroup>

      <FormActions>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>Save settings</button>
      </FormActions>
    </Panel>
  )
}
